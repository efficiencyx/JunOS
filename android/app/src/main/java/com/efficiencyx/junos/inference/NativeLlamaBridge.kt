package com.efficiencyx.junos.inference

class NativeLlamaBridge {
    interface Callback {
        fun onToken(token: String)
        fun onComplete()
        fun onError(message: String)
    }

    external fun nativeLoad(path: String, contextSize: Int, threads: Int)
    external fun nativeUnload()
    external fun nativeCancel()
    external fun nativeGenerate(
        roles: Array<String>,
        contents: Array<String>,
        maxTokens: Int,
        temperature: Float,
        callback: Callback,
    )

    companion object {
        init { System.loadLibrary("junos_llama") }
    }
}
