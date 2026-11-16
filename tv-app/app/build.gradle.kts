plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// release 签名材料只从 CI/本机构建环境注入，不写入仓库。
val releaseKeystore = System.getenv("CASTHUB_KEYSTORE_FILE")

android {
    namespace = "io.casthub.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.casthub.tv"
        minSdk = 23
        targetSdk = 34
        versionCode = 4
        versionName = "0.2.1"
    }

    signingConfigs {
        if (!releaseKeystore.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("CASTHUB_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CASTHUB_KEY_ALIAS")
                keyPassword = System.getenv("CASTHUB_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 未提供签名材料时仍可产出 unsigned APK 供本地检查；正式发布必须注入环境变量。
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-ui:1.3.1")
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
}
