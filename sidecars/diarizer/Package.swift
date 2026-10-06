// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HearloomDiarizer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "hearloom-diarizer", targets: ["HearloomDiarizer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5"),
    ],
    targets: [
        .executableTarget(
            name: "HearloomDiarizer",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
