pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        ivy {
            name = "sherpaOnnxReleases"
            url = uri("https://github.com/k2-fsa/sherpa-onnx/releases/download")
            patternLayout { artifact("v[revision]/[artifact]-[revision].[ext]") }
            metadataSources { artifact() }
            content { includeModule("k2-fsa", "sherpa-onnx") }
        }
        ivy {
            name = "pythonSdists"
            url = uri("https://files.pythonhosted.org/packages/source")
            patternLayout { artifact("[organisation]/[module]/[module]-[revision].[ext]") }
            metadataSources { artifact() }
            content { includeModule("u", "unitypy") }
        }
    }
}

rootProject.name = "JunOSAndroid"
include(":app")
