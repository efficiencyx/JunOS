import java.security.MessageDigest
import java.util.zip.ZipFile
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("com.chaquo.python")
}

android {
    namespace = "com.efficiencyx.junos"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.efficiencyx.junos"
        minSdk = 29
        targetSdk = 35
        versionCode = providers.environmentVariable("JUN_ANDROID_VERSION_CODE").orNull?.toInt() ?: 1
        versionName = providers.environmentVariable("JUN_ANDROID_VERSION_NAME").orNull ?: "0.1.0"

        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val keystore = providers.environmentVariable("JUN_ANDROID_KEYSTORE")
            if (keystore.isPresent) {
                signingConfig = signingConfigs.create("releaseEnv") {
                    storeFile = file(keystore.get())
                    storePassword = providers.environmentVariable("JUN_ANDROID_STORE_PASSWORD").orNull
                    keyAlias = providers.environmentVariable("JUN_ANDROID_KEY_ALIAS").orNull
                    keyPassword = providers.environmentVariable("JUN_ANDROID_KEY_PASSWORD").orNull
                }
            }
        }
    }

    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // the JVM tests touch android.util.Log. its stub jar throws
    // on every single call unless we ask for defaults.
    testOptions.unitTests.isReturnDefaultValues = true

    packaging {
        jniLibs.useLegacyPackaging = false
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }

    sourceSets.named("main") {
        assets.directories += layout.buildDirectory.dir("generated/junWeb").get().asFile.path
        providers.gradleProperty("litertlmLocal").orNull?.let { jniLibs.directories += "$it/jni" }
    }
}

kotlin {
    compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 }
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

chaquopy {
    defaultConfig {
        version = "3.12"
        val configuredPython = providers.environmentVariable("JUN_PYTHON_312").orNull
        val localPython = System.getenv("LOCALAPPDATA")?.let { file("$it/JunOS/python312/python.exe") }
        buildPython(configuredPython ?: localPython?.takeIf { it.isFile }?.absolutePath ?: "python3.12")
        pip {
            options("--no-deps")
            install("-r", "src/main/python/requirements.txt")
        }
    }
    sourceSets {
        getByName("main") {
            srcDir(layout.buildDirectory.dir("generated/recoveryPython"))
            srcDir(layout.buildDirectory.dir("generated/unityPyPython"))
        }
    }
    productFlavors { }
}

val unityPyVersion = "1.25.4"
val tpkArVersion = "0.2.4"
val unityPySdist = configurations.create("unityPySdist")
val tpkArSdist = configurations.create("tpkArSdist")

val verifyUnityPySdist = tasks.register("verifyUnityPySdist") {
    doLast {
        fun sha256(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(sha256(unityPySdist.singleFile) == "91d6169d73db8eb5f11fd6531b4e5e980f53dae00d5e3cbab827bbf4765de6d3") {
            "UnityPy sdist checksum mismatch"
        }
        check(sha256(tpkArSdist.singleFile) == "d64897e5a0bcddd58e8a7d4dd922f372da984a0f98bc3b460ec869aab906ee78") {
            "tpk_ar sdist checksum mismatch"
        }
    }
}

// UnityPy wheels ship UnityPyBoost, which has no android build.
// every call falls back to pure python anyway, so we unpack the
// package tree out of the sdist and leave its C++ sibling behind.
// keep this version in step with the desktop installers. before
// 1.10, UnityPy reads this game's Unity 6 Texture2D headers Wrong.
val unpackUnityPy = tasks.register<Copy>("unpackUnityPy") {
    dependsOn(verifyUnityPySdist)
    from(provider { tarTree(resources.gzip(unityPySdist.singleFile)) }) {
        include("unitypy-$unityPyVersion/UnityPy/**")
        exclude("**/*.pyi")
        eachFile { path = path.substringAfter("unitypy-$unityPyVersion/") }
    }
    // UnityPy 1.25.4 imports tpk_ar at load. pure python, sdist only,
    // and chaquopy won't install a PyPI sdist, so it comes in the same way
    from(provider { tarTree(resources.gzip(tpkArSdist.singleFile)) }) {
        include("tpk_ar-$tpkArVersion/tpk_ar/**")
        eachFile { path = path.substringAfter("tpk_ar-$tpkArVersion/") }
    }
    includeEmptyDirs = false
    into(layout.buildDirectory.dir("generated/unityPyPython"))
}

tasks.named("preBuild").configure { dependsOn(unpackUnityPy) }
tasks.matching { it.name.matches(Regex("merge(.*)PythonSources")) }.configureEach {
    dependsOn(unpackUnityPy)
}

val generateJunWebAssets = tasks.register<Copy>("generateJunWebAssets") {
    from(rootProject.projectDir.parentFile.resolve("webapp")) {
        exclude("api/**", "assets/**", "**/*.php", "lore_corpus.txt", "lore_index.bin", "lore_meta.json")
    }
    from(rootProject.projectDir.parentFile.resolve("tools/lore_dataset.jsonl")) {
        into("data")
    }
    into(layout.buildDirectory.dir("generated/junWeb"))
}

tasks.named("preBuild").configure { dependsOn(generateJunWebAssets) }

val generateRecoverySource = tasks.register<Copy>("generateRecoverySource") {
    from(rootProject.projectDir.parentFile.resolve("tools/recover_assets.py"))
    into(layout.buildDirectory.dir("generated/recoveryPython"))
}

tasks.named("preBuild").configure { dependsOn(generateRecoverySource) }
tasks.matching { it.name.matches(Regex("merge(.*)PythonSources")) }.configureEach {
    dependsOn(generateRecoverySource)
}

val sherpaAar = configurations.create("sherpaAar")
configurations.named("implementation") { extendsFrom(sherpaAar) }

val verifySherpaAar = tasks.register("verifySherpaAar") {
    doLast {
        val file = sherpaAar.singleFile
        val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(digest == "633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96") {
            "sherpa-onnx AAR checksum mismatch"
        }
    }
}

tasks.named("preBuild").configure { dependsOn(verifySherpaAar) }

val verifyPinnedManifests = tasks.register("verifyPinnedManifests") {
    doLast {
        val file = file("src/main/assets/manifests/litert_model.json")
        val manifest = JsonSlurper().parse(file) as Map<*, *>
        check((manifest["download_url"] as? String)?.startsWith("https://") == true)
        check((manifest["sha256"] as? String)?.matches(Regex("[a-fA-F0-9]{64}")) == true)
        check((manifest["size"] as? Number)?.toLong()?.let { it > 0 } == true) {
            "litert_model.json needs a pinned release URL, size, and SHA-256 before a release build."
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyPinnedManifests) }

val forbiddenReleaseEntries = listOf(
    Regex("(?i).*\\.gguf$"), Regex("(?i).*\\.litertlm$"), Regex("(?i).*\\.(zip|apk)$"),
    Regex("(?i).*webapp/assets/.*"), Regex("(?i).*(omega\\.sqlite|meta\\.json)$"),
)

tasks.register("verifyReleaseContents") {
    dependsOn("assembleRelease")
    doLast {
        val apk = layout.buildDirectory.dir("outputs/apk/release").get().asFile
            .walkTopDown().firstOrNull { it.extension == "apk" }
            ?: error("Release APK not found")
        ZipFile(apk).use { zip ->
            val forbidden = zip.entries().asSequence().map { it.name }
                .filter { name -> forbiddenReleaseEntries.any { it.matches(name) } }.toList()
            check(forbidden.isEmpty()) { "Forbidden private content in APK: ${forbidden.joinToString()}" }
        }
        check(apk.length() <= 180L * 1024 * 1024) {
            "Release APK is ${apk.length() / 1024 / 1024} MiB; limit is 180 MiB"
        }
    }
}

dependencies {
    sherpaAar("k2-fsa:sherpa-onnx:1.13.8@aar")
    unityPySdist("u:unitypy:$unityPyVersion@tar.gz")
    tpkArSdist("t:tpk_ar:$tpkArVersion@tar.gz")
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")

    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.webkit:webkit:1.18.0")

    implementation("io.ktor:ktor-server-cio:3.6.0")
    implementation("io.ktor:ktor-server-core:3.6.0")
    implementation("io.ktor:ktor-server-content-negotiation:3.6.0")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.6.0")
    implementation("io.ktor:ktor-server-status-pages:3.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    val litertlmLocal = providers.gradleProperty("litertlmLocal").orNull
    if (litertlmLocal != null) {
        implementation(files("$litertlmLocal/classes.jar"))
        implementation("com.google.code.gson:gson:2.14.0")
        implementation("org.jetbrains.kotlin:kotlin-reflect:2.4.0")
    } else {
        implementation("com.google.ai.edge.litertlm:litertlm-android:0.18.1")
    }
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.apache.commons:commons-compress:1.28.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
