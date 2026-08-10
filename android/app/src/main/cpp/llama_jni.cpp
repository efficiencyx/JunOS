#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

namespace {
constexpr const char * TAG = "JunLlama";
std::mutex engine_mutex;
std::atomic_bool cancelled{false};
llama_model * model = nullptr;
llama_context * context = nullptr;

std::string java_string(JNIEnv * env, jstring value) {
    if (!value) return {};
    const char * chars = env->GetStringUTFChars(value, nullptr);
    std::string out(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(value, chars);
    return out;
}

void throw_state(JNIEnv * env, const std::string & message) {
    jclass type = env->FindClass("java/lang/IllegalStateException");
    env->ThrowNew(type, message.c_str());
}

void free_engine() {
    if (context) {
        llama_free(context);
        context = nullptr;
    }
    if (model) {
        llama_model_free(model);
        model = nullptr;
    }
}

bool emit_token(JNIEnv * env, jobject callback, jmethodID method, const std::string & token) {
    jstring value = env->NewStringUTF(token.c_str());
    env->CallVoidMethod(callback, method, value);
    env->DeleteLocalRef(value);
    return !env->ExceptionCheck();
}
}

extern "C" JNIEXPORT void JNICALL
Java_com_efficiencyx_junos_inference_NativeLlamaBridge_nativeLoad(
    JNIEnv * env, jobject, jstring path, jint context_size, jint threads) {
    std::lock_guard<std::mutex> guard(engine_mutex);
    free_engine();
    llama_backend_init();
    llama_model_params model_params = llama_model_default_params();
    model_params.use_mmap = true;
    const std::string model_path = java_string(env, path);
    model = llama_model_load_from_file(model_path.c_str(), model_params);
    if (!model) return throw_state(env, "Could not load GGUF model");

    llama_context_params params = llama_context_default_params();
    params.n_ctx = static_cast<uint32_t>(context_size);
    params.n_batch = 512;
    params.n_ubatch = 256;
    params.n_threads = threads;
    params.n_threads_batch = threads;
    context = llama_init_from_model(model, params);
    if (!context) {
        free_engine();
        return throw_state(env, "Could not create llama context");
    }
}

extern "C" JNIEXPORT void JNICALL
Java_com_efficiencyx_junos_inference_NativeLlamaBridge_nativeUnload(JNIEnv *, jobject) {
    std::lock_guard<std::mutex> guard(engine_mutex);
    cancelled = true;
    free_engine();
    llama_backend_free();
}

extern "C" JNIEXPORT void JNICALL
Java_com_efficiencyx_junos_inference_NativeLlamaBridge_nativeCancel(JNIEnv *, jobject) {
    cancelled = true;
}

extern "C" JNIEXPORT void JNICALL
Java_com_efficiencyx_junos_inference_NativeLlamaBridge_nativeGenerate(
    JNIEnv * env,
    jobject,
    jobjectArray role_values,
    jobjectArray content_values,
    jint max_tokens,
    jfloat temperature,
    jobject callback) {
    std::lock_guard<std::mutex> guard(engine_mutex);
    if (!model || !context) return throw_state(env, "Model is not loaded");
    cancelled = false;

    const jsize count = env->GetArrayLength(role_values);
    if (count != env->GetArrayLength(content_values)) return throw_state(env, "Invalid message arrays");
    std::vector<std::string> roles;
    std::vector<std::string> contents;
    roles.reserve(count);
    contents.reserve(count);
    for (jsize i = 0; i < count; ++i) {
        auto role = static_cast<jstring>(env->GetObjectArrayElement(role_values, i));
        auto content = static_cast<jstring>(env->GetObjectArrayElement(content_values, i));
        roles.push_back(java_string(env, role));
        contents.push_back(java_string(env, content));
        env->DeleteLocalRef(role);
        env->DeleteLocalRef(content);
    }
    std::vector<llama_chat_message> messages;
    messages.reserve(count);
    for (jsize i = 0; i < count; ++i) messages.push_back({roles[i].c_str(), contents[i].c_str()});

    const char * chat_template = llama_model_chat_template(model, nullptr);
    int32_t required = llama_chat_apply_template(chat_template, messages.data(), messages.size(), true, nullptr, 0);
    if (required <= 0) return throw_state(env, "Model chat template is unsupported");
    std::vector<char> prompt_buffer(static_cast<size_t>(required) + 1);
    required = llama_chat_apply_template(
        chat_template, messages.data(), messages.size(), true, prompt_buffer.data(), prompt_buffer.size());
    if (required <= 0) return throw_state(env, "Could not apply model chat template");
    std::string prompt(prompt_buffer.data(), static_cast<size_t>(required));

    const llama_vocab * vocab = llama_model_get_vocab(model);
    int32_t token_count = llama_tokenize(vocab, prompt.data(), prompt.size(), nullptr, 0, true, true);
    if (token_count >= 0) return throw_state(env, "Tokenizer did not report required capacity");
    std::vector<llama_token> prompt_tokens(static_cast<size_t>(-token_count));
    token_count = llama_tokenize(
        vocab, prompt.data(), prompt.size(), prompt_tokens.data(), prompt_tokens.size(), true, true);
    if (token_count <= 0 || token_count >= static_cast<int32_t>(llama_n_ctx(context))) {
        return throw_state(env, "Prompt exceeds the 4096-token Android context");
    }
    prompt_tokens.resize(static_cast<size_t>(token_count));
    llama_memory_clear(llama_get_memory(context), true);
    for (size_t offset = 0; offset < prompt_tokens.size(); offset += 512) {
        const int32_t size = static_cast<int32_t>(std::min<size_t>(512, prompt_tokens.size() - offset));
        llama_batch batch = llama_batch_get_one(prompt_tokens.data() + offset, size);
        if (llama_decode(context, batch) != 0) return throw_state(env, "Prompt decoding failed");
    }

    llama_sampler * sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(std::max(0.05f, temperature)));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    jclass callback_class = env->GetObjectClass(callback);
    jmethodID on_token = env->GetMethodID(callback_class, "onToken", "(Ljava/lang/String;)V");
    jmethodID on_complete = env->GetMethodID(callback_class, "onComplete", "()V");
    jmethodID on_error = env->GetMethodID(callback_class, "onError", "(Ljava/lang/String;)V");
    if (!on_token || !on_complete || !on_error) {
        llama_sampler_free(sampler);
        return throw_state(env, "Invalid native callback");
    }

    for (int generated = 0; generated < max_tokens && !cancelled; ++generated) {
        llama_token token = llama_sampler_sample(sampler, context, -1);
        llama_sampler_accept(sampler, token);
        if (llama_vocab_is_eog(vocab, token)) break;
        char piece_buffer[512];
        int32_t piece_size = llama_token_to_piece(vocab, token, piece_buffer, sizeof(piece_buffer), 0, false);
        if (piece_size < 0) {
            std::vector<char> larger(static_cast<size_t>(-piece_size));
            piece_size = llama_token_to_piece(vocab, token, larger.data(), larger.size(), 0, false);
            if (piece_size > 0 && !emit_token(env, callback, on_token, {larger.data(), static_cast<size_t>(piece_size)})) break;
        } else if (piece_size > 0 && !emit_token(env, callback, on_token, {piece_buffer, static_cast<size_t>(piece_size)})) {
            break;
        }
        llama_batch batch = llama_batch_get_one(&token, 1);
        if (llama_decode(context, batch) != 0) {
            jstring error = env->NewStringUTF("Token decoding failed");
            env->CallVoidMethod(callback, on_error, error);
            env->DeleteLocalRef(error);
            llama_sampler_free(sampler);
            return;
        }
    }
    llama_sampler_free(sampler);
    env->CallVoidMethod(callback, on_complete);
}
