import Foundation
import Testing

@Suite("GC Console release app smoke tests")
struct ReleaseAppSmokeTests {
  private let timeoutSeconds: TimeInterval = 25

  @Test("release app bundle includes bundled runtime")
  func bundleContainsBundledRuntime() throws {
    #expect(FileManager.default.fileExists(atPath: appBundle.path))
    #expect(FileManager.default.fileExists(atPath: appExecutable.path))
    #expect(FileManager.default.fileExists(atPath: nodeSidecar.path))
    #expect(FileManager.default.fileExists(atPath: bundledIndex.path))
  }

  @Test("release app boots backend and serves dashboard")
  func releaseAppBootsBackend() async throws {
    try terminateProcessesOnPort3131()

    let process = Process()
    process.executableURL = appExecutable
    process.currentDirectoryURL = appExecutable.deletingLastPathComponent()
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()

    defer {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      try? terminateProcessesOnPort3131()
    }

    try await waitForHealthcheck()

    let html = try await fetch(URL(string: "http://127.0.0.1:3131/")!)
    #expect(html.contains("GC Console"))
  }

  private var repoRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private var appBundle: URL {
    repoRoot
      .appendingPathComponent("src-tauri")
      .appendingPathComponent("target")
      .appendingPathComponent("release")
      .appendingPathComponent("bundle")
      .appendingPathComponent("macos")
      .appendingPathComponent("GC Console.app")
  }

  private var appExecutable: URL {
    appBundle
      .appendingPathComponent("Contents")
      .appendingPathComponent("MacOS")
      .appendingPathComponent("app")
  }

  private var nodeSidecar: URL {
    appBundle
      .appendingPathComponent("Contents")
      .appendingPathComponent("MacOS")
      .appendingPathComponent("node-sidecar")
  }

  private var bundledIndex: URL {
    appBundle
      .appendingPathComponent("Contents")
      .appendingPathComponent("Resources")
      .appendingPathComponent("_up_")
      .appendingPathComponent("public")
      .appendingPathComponent("index.html")
  }

  private func fetch(_ url: URL) async throws -> String {
    let (data, _) = try await URLSession.shared.data(from: url)
    return String(data: data, encoding: .utf8) ?? ""
  }

  private func waitForHealthcheck() async throws {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      if let body = try? await fetch(URL(string: "http://127.0.0.1:3131/api/health")!), body.contains("\"ok\":true") {
        return
      }
      try await Task.sleep(for: .milliseconds(500))
    }
    throw SmokeTestError("Timed out waiting for http://127.0.0.1:3131/api/health")
  }

  private func terminateProcessesOnPort3131() throws {
    let output = try run("/usr/sbin/lsof", ["-ti", "tcp:3131"]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !output.isEmpty else { return }

    let pids = output
      .split(whereSeparator: \.isNewline)
      .map(String.init)
      .filter { !$0.isEmpty }

    guard !pids.isEmpty else { return }
    _ = try run("/bin/kill", ["-TERM"] + pids)
    Thread.sleep(forTimeInterval: 1)
  }

  @discardableResult
  private func run(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe

    try process.run()
    process.waitUntilExit()

    let stdout = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderr = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

    if process.terminationStatus != 0 && process.terminationStatus != 1 {
      throw SmokeTestError("\(executable) failed: \(stderr)")
    }

    return stdout
  }
}

struct SmokeTestError: Error, CustomStringConvertible {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var description: String { message }
}
