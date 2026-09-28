import SwiftUI
import AppKit
import UserNotifications

// MARK: - JSON models (mirror src/menubar-cli.js output)

struct DayOption: Decodable, Identifiable, Hashable {
    let value: String
    let day: Int
    var id: String { value }
}

struct MonthOption: Decodable, Identifiable, Hashable {
    let key: String
    let label: String
    let days: [DayOption]
    var id: String { key }
}

struct Train: Decodable, Identifiable, Hashable {
    let departure: String
    let arrival: String
    let available: Bool
    var id: String { departure }
}

struct Subscription: Decodable, Identifiable, Hashable {
    let id: String
    let date: String
    let direction: String
    let time: String
    let alerted: Bool
    let from: String
    let to: String
}

struct NewlyAvailable: Decodable {
    let id: String
    let date: String
    let direction: String
    let time: String
    let from: String
    let to: String
    let arrival: String
    let url: String
}

struct CheckError: Decodable {
    let direction: String
    let date: String
    let message: String
}

protocol CLIResponse: Decodable {
    var ok: Bool { get }
    var error: String? { get }
}

struct MonthsResponse: CLIResponse { let ok: Bool; let error: String?; let months: [MonthOption]? }
struct SearchResponse: CLIResponse { let ok: Bool; let error: String?; let url: String?; let from: String?; let to: String?; let date: String?; let trains: [Train]? }
struct SubscribeResponse: CLIResponse { let ok: Bool; let error: String?; let item: Subscription?; let created: Bool? }
struct ListResponse: CLIResponse { let ok: Bool; let error: String?; let subscriptions: [Subscription]? }
struct UnsubscribeResponse: CLIResponse { let ok: Bool; let error: String?; let removed: Bool? }
struct CheckResponse: CLIResponse {
    let ok: Bool
    let error: String?
    let newlyAvailable: [NewlyAvailable]?
    let becameUnavailable: [Subscription]?
    let expired: [Subscription]?
    let errors: [CheckError]?
}

// MARK: - Bridge to src/menubar-cli.js

enum NodeCLI {
    // Set at build time by build.sh (see BuildConfig in build/BuildConfig.swift).
    static let nodePath = BuildConfig.nodePath
    static let workingDir = BuildConfig.projectDir
    static let scriptPath = BuildConfig.projectDir + "/src/menubar-cli.js"

    static func run<T: CLIResponse>(_ args: [String]) async throws -> T {
        let data = try await runRaw(args)
        let decoded: T
        do {
            decoded = try JSONDecoder().decode(T.self, from: data)
        } catch {
            let raw = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "NodeCLI", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected response: \(raw.prefix(200))"
            ])
        }
        if !decoded.ok {
            throw NSError(domain: "NodeCLI", code: 2, userInfo: [
                NSLocalizedDescriptionKey: decoded.error ?? "Unknown error"
            ])
        }
        return decoded
    }

    private static func runRaw(_ args: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: nodePath)
                process.arguments = [scriptPath] + args
                process.currentDirectoryURL = URL(fileURLWithPath: workingDir)
                let outPipe = Pipe()
                let errPipe = Pipe()
                process.standardOutput = outPipe
                process.standardError = errPipe
                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                process.waitUntilExit()
                let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                let text = String(data: outData, encoding: .utf8) ?? ""
                let lastLine = text.split(separator: "\n").last.map(String.init) ?? ""
                if let lineData = lastLine.data(using: .utf8), !lineData.isEmpty {
                    continuation.resume(returning: lineData)
                } else {
                    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                    let errText = String(data: errData, encoding: .utf8) ?? "No output from node"
                    continuation.resume(throwing: NSError(domain: "NodeCLI", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: errText.isEmpty ? "No output from node" : errText
                    ]))
                }
            }
        }
    }
}

// MARK: - Navigation

enum Screen {
    case home
    case pickMonth
    case pickDay(monthKey: String, monthLabel: String)
    case pickDirection(date: String)
    case searching
    case pickTime(date: String, direction: String, from: String, to: String, trains: [Train])
    case confirmed(message: String)
    case myAlerts
}

// MARK: - App state

@MainActor
final class AppModel: ObservableObject {
    @Published var screen: Screen = .home
    @Published var months: [MonthOption] = []
    @Published var subscriptions: [Subscription] = []
    @Published var busy = false
    @Published var errorMessage: String?
    @Published var lastChecked: Date?

    private var timer: Timer?
    private let checkIntervalSeconds: TimeInterval = 60

    init() {
        requestNotificationPermission()
        Task { await refreshSubscriptions() }
        Task { await checkNow(silent: true) }
        timer = Timer.scheduledTimer(withTimeInterval: checkIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.checkNow(silent: true)
            }
        }
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func goHome() {
        screen = .home
        errorMessage = nil
    }

    func beginNewAlert() {
        errorMessage = nil
        screen = .pickMonth
        if months.isEmpty {
            Task { await loadMonths() }
        }
    }

    private func loadMonths() async {
        do {
            let response: MonthsResponse = try await NodeCLI.run(["months"])
            months = response.months ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func pickMonth(_ month: MonthOption) {
        screen = .pickDay(monthKey: month.key, monthLabel: month.label)
    }

    func pickDay(_ day: DayOption) {
        screen = .pickDirection(date: day.value)
    }

    func pickDirection(_ direction: String, date: String) {
        screen = .searching
        errorMessage = nil
        Task {
            do {
                let response: SearchResponse = try await NodeCLI.run(["search", "--date", date, "--direction", direction])
                let trains = response.trains ?? []
                if trains.isEmpty {
                    errorMessage = "برای این تاریخ قطاری که هنوز حرکت نکرده باشد یافت نشد."
                    screen = .pickDirection(date: date)
                    return
                }
                screen = .pickTime(date: date, direction: direction, from: response.from ?? "", to: response.to ?? "", trains: trains)
            } catch {
                errorMessage = error.localizedDescription
                screen = .pickDirection(date: date)
            }
        }
    }

    func pickTime(_ train: Train, date: String, direction: String, from: String, to: String) {
        Task {
            do {
                let _: SubscribeResponse = try await NodeCLI.run([
                    "subscribe",
                    "--date", date,
                    "--direction", direction,
                    "--time", train.departure,
                    "--alerted", train.available ? "true" : "false"
                ])
                let message = train.available
                    ? "این قطار همین حالا صندلی خالی دارد! برای خرید به سایت علی‌بابا مراجعه کنید."
                    : "هشدار ثبت شد. به محض خالی‌شدن صندلی به شما اطلاع می‌دهم."
                screen = .confirmed(message: "\(from) → \(to)\n\(date) ساعت \(train.departure)\n\n\(message)")
                await refreshSubscriptions()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func refreshSubscriptions() async {
        do {
            let response: ListResponse = try await NodeCLI.run(["list"])
            subscriptions = response.subscriptions ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteSubscription(_ subscription: Subscription) {
        Task {
            do {
                let _: UnsubscribeResponse = try await NodeCLI.run(["unsubscribe", "--id", subscription.id])
                await refreshSubscriptions()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func checkNow(silent: Bool) async {
        if !silent { busy = true }
        do {
            let response: CheckResponse = try await NodeCLI.run(["check"])
            lastChecked = Date()
            for item in response.newlyAvailable ?? [] {
                fireNotification(for: item)
            }
            if !silent, let firstError = (response.errors ?? []).first {
                errorMessage = firstError.message
            }
            await refreshSubscriptions()
        } catch {
            if !silent { errorMessage = error.localizedDescription }
        }
        if !silent { busy = false }
    }

    private func fireNotification(for item: NewlyAvailable) {
        let content = UNMutableNotificationContent()
        content.title = "🚨 صندلی خالی شد!"
        content.body = "\(item.from) → \(item.to)\n\(item.date) ساعت \(item.time)"
        content.sound = .default
        content.userInfo = ["url": item.url]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

// MARK: - UI

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("🚄 Train Alert")
                    .font(.headline)
                Spacer()
                Button {
                    NSApplication.shared.terminate(nil)
                } label: {
                    Image(systemName: "power")
                }
                .buttonStyle(.plain)
                .help("خروج")
            }

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            content
        }
        .padding(14)
        .frame(width: 300)
    }

    @ViewBuilder
    private var content: some View {
        switch model.screen {
        case .home:
            homeView
        case .pickMonth:
            monthView
        case .pickDay(let monthKey, let monthLabel):
            dayView(monthKey: monthKey, monthLabel: monthLabel)
        case .pickDirection(let date):
            directionView(date: date)
        case .searching:
            searchingView
        case .pickTime(let date, let direction, let from, let to, let trains):
            timeView(date: date, direction: direction, from: from, to: to, trains: trains)
        case .confirmed(let message):
            confirmedView(message: message)
        case .myAlerts:
            myAlertsView
        }
    }

    private var homeView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                model.beginNewAlert()
            } label: {
                Label("ساخت هشدار جدید", systemImage: "plus.circle")
            }

            Button {
                model.screen = .myAlerts
                Task { await model.refreshSubscriptions() }
            } label: {
                Label("هشدارهای من (\(model.subscriptions.count))", systemImage: "list.bullet")
            }

            Button {
                Task { await model.checkNow(silent: false) }
            } label: {
                if model.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Label("بررسی الان", systemImage: "arrow.clockwise")
                }
            }
            .disabled(model.busy)

            if let last = model.lastChecked {
                Text("آخرین بررسی: \(last.formatted(date: .omitted, time: .standard))")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var monthView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ماه سفر را انتخاب کنید:")
                .font(.subheadline)
            if model.months.isEmpty {
                ProgressView()
            } else {
                ForEach(model.months) { month in
                    Button(month.label) {
                        model.pickMonth(month)
                    }
                    .buttonStyle(.bordered)
                }
            }
            backButton
        }
    }

    private func dayView(monthKey: String, monthLabel: String) -> some View {
        let days = model.months.first(where: { $0.key == monthKey })?.days ?? []
        return VStack(alignment: .leading, spacing: 8) {
            Text("روز سفر (\(monthLabel)) را انتخاب کنید:")
                .font(.subheadline)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 6) {
                ForEach(days) { day in
                    Button("\(day.day)") {
                        model.pickDay(day)
                    }
                    .buttonStyle(.bordered)
                }
            }
            backButton
        }
    }

    private func directionView(date: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("تاریخ \(date) ثبت شد. مسیر را انتخاب کنید:")
                .font(.subheadline)
            Button("از قم به تهران") {
                model.pickDirection("qom-tehran", date: date)
            }
            .buttonStyle(.bordered)
            Button("از تهران به قم") {
                model.pickDirection("tehran-qom", date: date)
            }
            .buttonStyle(.bordered)
            backButton
        }
    }

    private var searchingView: some View {
        HStack {
            ProgressView()
            Text("در حال جستجوی قطارها…")
        }
    }

    private func timeView(date: String, direction: String, from: String, to: String, trains: [Train]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ساعت حرکت را انتخاب کنید:")
                .font(.subheadline)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 2), spacing: 6) {
                ForEach(trains) { train in
                    Button("\(train.departure) \(train.available ? "✅" : "⏳")") {
                        model.pickTime(train, date: date, direction: direction, from: from, to: to)
                    }
                    .buttonStyle(.bordered)
                }
            }
            backButton
        }
    }

    private func confirmedView(message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(message)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Button("بازگشت") {
                model.goHome()
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var myAlertsView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("هشدارهای فعال:")
                .font(.subheadline)
            if model.subscriptions.isEmpty {
                Text("هنوز هیچ هشداری ثبت نشده است.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ForEach(model.subscriptions) { sub in
                    HStack {
                        VStack(alignment: .leading) {
                            Text("\(sub.from) → \(sub.to)")
                                .font(.caption)
                            Text("\(sub.date) ساعت \(sub.time)")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Button {
                            model.deleteSubscription(sub)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            backButton
        }
    }

    private var backButton: some View {
        Button("بازگشت به خانه") {
            model.goHome()
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .padding(.top, 4)
    }
}

// MARK: - Notification click handling

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let urlString = response.notification.request.content.userInfo["url"] as? String,
           let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }
}

// MARK: - App entry point

@main
struct TrainAlertApp: App {
    @StateObject private var model = AppModel()
    private static let notificationDelegate = NotificationDelegate()

    init() {
        UNUserNotificationCenter.current().delegate = Self.notificationDelegate
    }

    var body: some Scene {
        MenuBarExtra("Train Alert", systemImage: "tram.fill") {
            ContentView()
                .environmentObject(model)
        }
        .menuBarExtraStyle(.window)
    }
}
