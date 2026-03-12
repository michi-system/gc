// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "GCSmokeTests",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .library(name: "GCSmokeHarness", targets: ["GCSmokeHarness"]),
  ],
  targets: [
    .target(
      name: "GCSmokeHarness"
    ),
    .testTarget(
      name: "GCSmokeTestsTests",
      dependencies: ["GCSmokeHarness"]
    ),
  ]
)
