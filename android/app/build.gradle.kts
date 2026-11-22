plugins { id("com.android.application") }

// version from the CI run number, so every build installs over the last one
val buildNo = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "ai.tasmi.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "ai.tasmi.app"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNo
        versionName = "1.$buildNo"
    }
    signingConfigs {
        create("release") {
            // the key comes from the build (CI writes it from a repository secret, see android/README.md)
            storeFile = file(System.getenv("TASMI_KEYSTORE") ?: "tasmi.keystore")
            storePassword = System.getenv("TASMI_KEY_PASSWORD") ?: ""
            keyAlias = System.getenv("TASMI_KEY_ALIAS") ?: "tasmi"
            keyPassword = System.getenv("TASMI_KEY_PASSWORD") ?: ""
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // the same page as the website: site/ is bundled into the app as its assets
    sourceSets["main"].assets.srcDirs("../../site")
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
