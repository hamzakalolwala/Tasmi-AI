pluginManagement {
    // Google's mirror of Maven Central first: Maven Central rate-limits CI runners (HTTP 429)
    repositories { google(); maven("https://maven-central.storage-download.googleapis.com/maven2/"); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); maven("https://maven-central.storage-download.googleapis.com/maven2/"); mavenCentral() }
}
rootProject.name = "TasmiAI"
include(":app")
