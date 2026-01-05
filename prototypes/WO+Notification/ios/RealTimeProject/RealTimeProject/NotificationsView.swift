import SwiftUI
import PhotosUI
import Combine

struct NotificationsView: View {

    @EnvironmentObject var voiceModel: VoiceChatViewModel
    @StateObject private var wizard = NotificationWizardViewModel()

    @State private var pendingFieldSync: [String: DispatchWorkItem] = [:]
    @State private var lastLocalEditAt: [String: Date] = [:]

    @State private var showCamera: Bool = false
    @State private var pendingVoiceRequestId: String? = nil
    @State private var galleryItems: [PhotosPickerItem] = []
    @State private var selectedPhoto: NotificationPhoto? = nil

    @State private var showQRScanner: Bool = false
    @State private var pendingQRRequestId: String? = nil

    @State private var jsonVisible: Bool = true

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(.systemGray6), Color(.systemGray5)],
                           startPoint: .top,
                           endPoint: .bottom)
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {

                    headerStatusRow
                    assistantCard
                    logsCard
                    manualEntryCard
                    attachmentsCard
                    draftPhotosCard

                    // NEW
                    visionInsightsCard

                    notificationDraftSummaryCard

                    if !voiceModel.notificationLatestJSONPretty.isEmpty {
                        jsonCard
                    }

                    startStopButton
                        .padding(.top, 10)
                        .padding(.bottom, 24)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
        }
        .onReceive(voiceModel.$notificationLatestDraft) { server in
            guard let server else { return }
            let merged = mergeServerDraftPreservingLocalEdits(server)
            wizard.applyServerDraft(merged)
        }
        .onReceive(voiceModel.$notificationPhotoRequest) { req in
            guard let req else { return }
            pendingVoiceRequestId = req.requestId
            showCamera = true
        }
        .onReceive(voiceModel.$notificationQRRequest) { req in
            guard let req else { return }
            pendingQRRequestId = req.requestId
            showQRScanner = true
        }
        .onChange(of: galleryItems, initial: false) { _, items in
            guard !items.isEmpty else { return }
            Task { await handleGallerySelection(items) }
        }
        .sheet(isPresented: $showCamera) {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                CameraImagePicker(sourceType: .camera) { img in
                    Task { await handleCapturedImage(img, source: pendingVoiceRequestId == nil ? "manual" : "voice") }
                    pendingVoiceRequestId = nil
                    voiceModel.clearNotificationPhotoRequest()
                    showCamera = false
                } onCancel: {
                    pendingVoiceRequestId = nil
                    voiceModel.clearNotificationPhotoRequest()
                    showCamera = false
                }
                .ignoresSafeArea()
            } else {
                VStack(spacing: 12) {
                    Text("Camera not available on this device.")
                    Button("Close") {
                        pendingVoiceRequestId = nil
                        voiceModel.clearNotificationPhotoRequest()
                        showCamera = false
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding()
            }
        }
        .sheet(isPresented: $showQRScanner) {
            QRCodeScannerView {
                let raw = $0
                showQRScanner = false
                pendingQRRequestId = nil
                voiceModel.clearNotificationQRRequest()
                Task { await handleScannedQRCode(raw) }
            } onCancel: {
                showQRScanner = false
                pendingQRRequestId = nil
                voiceModel.clearNotificationQRRequest()
            }
            .ignoresSafeArea()
        }
        .sheet(item: $selectedPhoto) { photo in
            photoViewerSheet(photo)
        }
    }

    // MARK: - Merge logic (prevents typing clobber)

    private func mergeServerDraftPreservingLocalEdits(_ server: NotificationDraft) -> NotificationDraft {
        var merged = server
        let preserve = fieldsToPreserveFromLocal()
        let local = wizard.draft

        func keep(_ field: String) -> Bool { preserve.contains(field) }

        if keep("notificationType") { merged.notificationType = local.notificationType }
        if keep("shortText") { merged.shortText = local.shortText }
        if keep("priority") { merged.priority = local.priority }
        if keep("equipmentID") { merged.equipmentID = local.equipmentID }
        if keep("functionalLocation") { merged.functionalLocation = local.functionalLocation }
        if keep("plant") { merged.plant = local.plant }
        if keep("reportedBy") { merged.reportedBy = local.reportedBy }

        return merged
    }

    private func fieldsToPreserveFromLocal() -> Set<String> {
        let now = Date()
        let preserveWindow: TimeInterval = 1.2

        var s: Set<String> = Set(pendingFieldSync.keys)
        for (field, t) in lastLocalEditAt {
            if now.timeIntervalSince(t) < preserveWindow { s.insert(field) }
        }
        return s
    }

    // MARK: - UI

    private var headerStatusRow: some View {
        HStack {
            Image(systemName: voiceModel.isRunning ? "waveform.circle.fill" : "dot.circle")
                .foregroundColor(voiceModel.isRunning ? .green : .gray)
                .font(.system(size: 22, weight: .bold))

            Text(voiceModel.status)
                .font(.title3.bold())

            Spacer()

            Text("Notifications")
                .font(.headline)
                .foregroundColor(.secondary)
        }
    }

    private var assistantCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Assistant").font(.headline)

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if voiceModel.isAIPlaying && !voiceModel.currentTranscript.isEmpty {
                        Text(voiceModel.currentTranscript)
                            .italic()
                            .foregroundColor(.secondary)
                    }

                    Text(voiceModel.fullResponseText.isEmpty ? "—" : voiceModel.fullResponseText)
                        .font(.body)
                }
                .padding(.vertical, 4)
            }
            .frame(height: 140)

            if !voiceModel.notificationLastActionSummary.isEmpty {
                Divider()
                Text(voiceModel.notificationLastActionSummary)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private var logsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Logs")
                .font(.caption.bold())
                .foregroundColor(.secondary)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(voiceModel.logs.indices, id: \.self) { idx in
                        Text(voiceModel.logs[idx])
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(height: 140)
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.07), radius: 6, x: 0, y: 3)
    }

    private var manualEntryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Manual Field Entry").font(.headline)
                Spacer()
                Button("Flush") { flushPendingFieldSync() }
                    .buttonStyle(.bordered)
            }

            fieldRow(title: "Notification Type") {
                TextField("e.g., PM01",
                          text: syncedBinding(field: "notificationType", keyPath: \.notificationType))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Short Text (multi-line)") {
                TextEditor(text: syncedBinding(field: "shortText", keyPath: \.shortText))
                    .frame(minHeight: 100)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.25)))
            }

            fieldRow(title: "Priority") {
                TextField("e.g., 1 / 2 / 3",
                          text: syncedBinding(field: "priority", keyPath: \.priority))
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Equipment ID") {
                TextField("e.g., 10001234",
                          text: syncedBinding(field: "equipmentID", keyPath: \.equipmentID))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Functional Location") {
                TextField("e.g., FL-100-200",
                          text: syncedBinding(field: "functionalLocation", keyPath: \.functionalLocation))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Plant") {
                TextField("e.g., 1000",
                          text: syncedBinding(field: "plant", keyPath: \.plant))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Reported By") {
                TextField("e.g., operator01",
                          text: syncedBinding(field: "reportedBy", keyPath: \.reportedBy))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private func fieldRow(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.bold())
                .foregroundColor(.secondary)
            content()
        }
    }

    private var attachmentsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Attachments").font(.headline)
                Spacer()

                Button {
                    pendingVoiceRequestId = nil
                    showCamera = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
                .buttonStyle(.bordered)

                PhotosPicker(selection: $galleryItems, maxSelectionCount: 5, matching: .images) {
                    Label("Gallery", systemImage: "photo.on.rectangle")
                }
                .buttonStyle(.bordered)

                Button {
                    pendingQRRequestId = nil
                    showQRScanner = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.bordered)
            }

            if voiceModel.notificationUploadInFlight {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Uploading / updating…")
                        .foregroundColor(.secondary)
                }
            }

            if let err = voiceModel.notificationUploadError, !err.isEmpty {
                Text(err)
                    .foregroundColor(.red)
                    .font(.subheadline)
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private var draftPhotosCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Draft Photos").font(.headline)
                Spacer()
                Text("\(wizard.draft.photos.count)")
                    .foregroundColor(.secondary)
                    .font(.subheadline)
            }

            if wizard.draft.photos.isEmpty {
                Text("No photos attached yet.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(wizard.draft.photos) { photo in
                            photoThumb(photo)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    // NEW: Vision Insights UI
    private var visionInsightsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Vision Insights").font(.headline)
                Spacer()
                Text("\(voiceModel.notificationVisionResults.count)")
                    .foregroundColor(.secondary)
                    .font(.subheadline)
            }

            if voiceModel.notificationVisionResults.isEmpty {
                Text("No vision results yet. Attach a photo to trigger fallback analysis.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                let top = voiceModel.notificationVisionResults.prefix(3)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(top)) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(r.filename).font(.subheadline.bold())
                                Spacer()
                                if let c = r.confidence {
                                    Text(String(format: "conf %.2f", c))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }

                            if r.ok {
                                if let summary = r.summary, !summary.isEmpty {
                                    Text(summary).font(.caption)
                                }
                                if let labels = r.labels, !labels.isEmpty {
                                    Text("Labels: \(labels.joined(separator: ", "))")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                }
                                if let applied = r.appliedFields, !applied.isEmpty {
                                    Text("Auto-applied: \(applied.keys.sorted().joined(separator: ", "))")
                                        .font(.caption2)
                                        .foregroundColor(.green)
                                } else {
                                    Text("Auto-applied: none")
                                        .font(.caption2)
                                        .foregroundColor(.secondary)
                                }
                            } else {
                                Text("Vision failed for this photo.")
                                    .font(.caption)
                                    .foregroundColor(.orange)
                            }
                        }
                        .padding(10)
                        .background(Color.black.opacity(0.04))
                        .cornerRadius(12)
                    }
                }
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private func photoThumb(_ photo: NotificationPhoto) -> some View {
        let url = photoURL(photo)

        return ZStack(alignment: .topTrailing) {
            Button { selectedPhoto = photo } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color.black.opacity(0.06))
                        .frame(width: 120, height: 90)

                    if let url {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .empty:
                                ProgressView()
                            case .success(let img):
                                img.resizable().scaledToFill()
                            case .failure:
                                Image(systemName: "photo")
                                    .font(.system(size: 22, weight: .semibold))
                                    .foregroundColor(.secondary)
                            @unknown default:
                                EmptyView()
                            }
                        }
                        .frame(width: 120, height: 90)
                        .clipped()
                        .cornerRadius(14)
                    }
                }
            }
            .buttonStyle(.plain)

            Button(role: .destructive) {
                Task { await removePhoto(photo) }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(.white)
                    .shadow(radius: 2)
            }
            .padding(6)
            .disabled(voiceModel.notificationUploadInFlight)
        }
    }

    private func photoViewerSheet(_ photo: NotificationPhoto) -> some View {
        VStack(spacing: 12) {
            HStack {
                Text(photo.filename).font(.headline).lineLimit(1)
                Spacer()
                Button("Close") { selectedPhoto = nil }
                    .buttonStyle(.bordered)
            }

            if let url = photoURL(photo) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty: ProgressView()
                    case .success(let img): img.resizable().scaledToFit()
                    case .failure: Text("Failed to load image.").foregroundColor(.secondary)
                    @unknown default: EmptyView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text("No image URL available.").foregroundColor(.secondary)
            }

            Button(role: .destructive) {
                Task {
                    await removePhoto(photo)
                    selectedPhoto = nil
                }
            } label: {
                Label("Remove photo", systemImage: "trash")
            }
            .buttonStyle(.borderedProminent)
            .disabled(voiceModel.notificationUploadInFlight)
        }
        .padding()
    }

    private func photoURL(_ photo: NotificationPhoto) -> URL? {
        guard let sp = photo.serverPath, !sp.isEmpty else { return nil }
        return URL(string: "\(voiceModel.serverBaseURL)/\(sp)")
    }

    private func removePhoto(_ photo: NotificationPhoto) async {
        wizard.removeLocalPhoto(filename: photo.filename)
        await voiceModel.removeNotificationPhoto(filename: photo.filename)
    }

    private var notificationDraftSummaryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Notification Draft").font(.headline)

            let missing = voiceModel.notificationMissingRequired
            if !missing.isEmpty {
                Text("Missing required: \(missing.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundColor(.orange)
            } else {
                Text("Required fields complete.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            gridRow("ID", wizard.draft.notificationId ?? "—")
            gridRow("Type", wizard.draft.notificationType ?? "—")
            gridRow("Short Text", wizard.draft.shortText ?? "—")
            gridRow("Priority", wizard.draft.priority ?? "—")
            gridRow("Equipment", wizard.draft.equipmentID ?? "—")
            gridRow("Func. Location", wizard.draft.functionalLocation ?? "—")
            gridRow("Plant", wizard.draft.plant ?? "—")
            gridRow("Reported By", wizard.draft.reportedBy ?? "—")
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private func gridRow(_ key: String, _ val: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(key)
                .font(.caption.bold())
                .foregroundColor(.secondary)
                .frame(width: 110, alignment: .leading)

            Text(val.isEmpty ? "—" : val)
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var jsonCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Notification JSON").font(.headline)
                Spacer()
                Button(jsonVisible ? "Hide" : "Show") { jsonVisible.toggle() }
                    .buttonStyle(.bordered)
            }

            if jsonVisible {
                TextEditor(text: .constant(voiceModel.notificationLatestJSONPretty))
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 220)
                    .disabled(true)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.2)))
            }
        }
        .padding()
        .background(.thinMaterial)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }

    private var startStopButton: some View {
        Button(action: {
            flushPendingFieldSync()
            voiceModel.isRunning ? voiceModel.stopConversation() : voiceModel.startConversation()
        }) {
            ZStack {
                Circle()
                    .fill(voiceModel.isRunning ? Color.red.gradient : Color.blue.gradient)
                    .frame(width: 84, height: 84)
                    .shadow(color: (voiceModel.isRunning ? Color.red : Color.blue).opacity(0.35),
                            radius: 10, x: 0, y: 6)

                Image(systemName: voiceModel.isRunning ? "stop.fill" : "mic.fill")
                    .foregroundColor(.white)
                    .font(.system(size: 34, weight: .bold))
            }
        }
    }

    // MARK: - Field binding / syncing

    private func debounceInterval(for field: String) -> TimeInterval {
        if field == "shortText" { return 0.45 }
        return 0.12
    }

    private func syncedBinding(field: String, keyPath: WritableKeyPath<NotificationDraft, String?>) -> Binding<String> {
        Binding<String>(
            get: { wizard.draft[keyPath: keyPath] ?? "" },
            set: { newValue in
                lastLocalEditAt[field] = Date()
                let v: String? = newValue.isEmpty ? nil : newValue
                wizard.setLocalField(field, value: v)

                pendingFieldSync[field]?.cancel()
                let work = DispatchWorkItem {
                    Task {
                        await voiceModel.syncNotificationField(field: field, value: v)
                        await MainActor.run { pendingFieldSync[field] = nil }
                    }
                }
                pendingFieldSync[field] = work
                DispatchQueue.main.asyncAfter(deadline: .now() + debounceInterval(for: field), execute: work)
            }
        )
    }

    private func flushPendingFieldSync() {
        let fields = pendingFieldSync.keys
        for f in fields {
            pendingFieldSync[f]?.cancel()
            pendingFieldSync[f] = nil
            let v = currentValue(for: f)
            Task { await voiceModel.syncNotificationField(field: f, value: v) }
        }
    }

    private func currentValue(for field: String) -> String? {
        switch field {
        case "notificationType": return wizard.draft.notificationType
        case "shortText": return wizard.draft.shortText
        case "priority": return wizard.draft.priority
        case "equipmentID": return wizard.draft.equipmentID
        case "functionalLocation": return wizard.draft.functionalLocation
        case "plant": return wizard.draft.plant
        case "reportedBy": return wizard.draft.reportedBy
        default: return nil
        }
    }

    // MARK: - Photos / QR

    private func handleCapturedImage(_ img: UIImage, source: String) async {
        let clientId = UUID().uuidString
        let requestId = pendingVoiceRequestId

        await voiceModel.attachNotificationPhoto(
            image: img,
            source: source,
            note: (source == "voice") ? "Voice capture" : "Camera/gallery capture",
            requestId: requestId,
            clientLocalId: clientId
        )
    }

    private func handleGallerySelection(_ items: [PhotosPickerItem]) async {
        defer { Task { @MainActor in self.galleryItems = [] } }

        for item in items {
            do {
                if let data = try await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    await handleCapturedImage(img, source: "manual")
                }
            } catch { }
        }
    }

    private func handleScannedQRCode(_ raw: String) async {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let fields = QRPayloadParser.parse(raw: trimmed)

        if !fields.isEmpty {
            for (k, v) in fields {
                lastLocalEditAt[k] = Date()
                wizard.setLocalField(k, value: v)
            }
            await voiceModel.setNotificationFields(fields: fields)
            return
        }

        await voiceModel.applyQRCode(raw: trimmed)
    }
}

private enum QRPayloadParser {
    static func parse(raw: String) -> [String: String] {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return [:] }

        if (t.hasPrefix("{") && t.hasSuffix("}")) || (t.hasPrefix("[") && t.hasSuffix("]")) {
            if let data = t.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

                var out: [String: String] = [:]
                func put(_ key: String, _ valueAny: Any?) {
                    guard let valueAny else { return }
                    let s = String(describing: valueAny)
                    if s.isEmpty { return }
                    out[key] = s
                }

                if let n = obj["Notification"] as? [String: Any] {
                    put("equipmentID", n["equipment_id"])
                    put("functionalLocation", n["functional_location"])
                    put("plant", n["plant"])
                    put("notificationType", n["notification_type"])
                    put("priority", n["priority"])
                    put("shortText", n["short_text"])
                    return out
                }

                if let schema = obj["schema"] as? String, schema == "sap.pm.qr.v1" {
                    if let asset = obj["asset"] as? [String: Any] {
                        put("equipmentID", asset["equipment_id"] ?? asset["equipmentID"])
                        put("functionalLocation", asset["functional_location"] ?? asset["functionalLocation"] ?? asset["floc"])
                        put("plant", asset["plant"] ?? asset["werks"])
                    }
                    if let defaults = obj["defaults"] as? [String: Any] {
                        put("notificationType", defaults["notification_type"] ?? defaults["notificationType"])
                        put("priority", defaults["priority"])
                        put("shortText", defaults["short_text"] ?? defaults["shortText"])
                    }
                    return out
                }

                put("equipmentID", obj["equipmentID"] ?? obj["equipment_id"])
                put("functionalLocation", obj["functionalLocation"] ?? obj["functional_location"] ?? obj["floc"])
                put("plant", obj["plant"] ?? obj["werks"])
                put("notificationType", obj["notificationType"] ?? obj["notification_type"])
                put("priority", obj["priority"])
                put("shortText", obj["shortText"] ?? obj["short_text"])
                return out
            }
        }
        return [:]
    }
}
