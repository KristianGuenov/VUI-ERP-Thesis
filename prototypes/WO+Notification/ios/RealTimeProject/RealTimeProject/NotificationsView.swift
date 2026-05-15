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

    @State private var jsonVisible: Bool = false
    @State private var showLogsSheet: Bool = false

    // Confirmation UI state
    @State private var showFieldConfirmDialog: Bool = false
    @State private var showFieldCorrectSheet: Bool = false
    @State private var pendingFieldConfirm: NotificationFieldConfirmRequest? = nil
    @State private var correctedValue: String = ""

    @State private var showFinalizeConfirmSheet: Bool = false
    @State private var pendingFinalizeConfirm: NotificationFinalizeConfirmRequest? = nil

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {

                    headerStatusRow

                    if voiceModel.notificationUploadInFlight || ((voiceModel.notificationUploadError ?? "").isEmpty == false) {
                        uploadStatusBanner
                    }

                    manualEntryCard
                    draftPhotosCard
                    visionInsightsCard
                    notificationDraftSummaryCard

                    if !voiceModel.notificationLatestJSONPretty.isEmpty {
                        jsonCard
                    }

                    startStopButton
                        .padding(.top, 8)
                        .padding(.bottom, 16)
                        .frame(maxWidth: .infinity, alignment: .center)

                    Color.clear.frame(height: 90)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
        }
        .safeAreaInset(edge: .bottom) { bottomAttachmentBar }

        // Merge server draft into wizard (preserving local edits)
        .onReceive(voiceModel.$notificationLatestDraft) { server in
            guard let server else { return }
            let merged = mergeServerDraftPreservingLocalEdits(server)
            wizard.applyServerDraft(merged)
        }

        // Voice-driven photo request
        .onReceive(voiceModel.$notificationPhotoRequest) { req in
            guard let req else { return }
            pendingVoiceRequestId = req.requestId
            showCamera = true
        }

        // Voice-driven QR request
        .onReceive(voiceModel.$notificationQRRequest) { req in
            guard let req else { return }
            pendingQRRequestId = req.requestId
            showQRScanner = true
        }

        // NEW: critical numeric field confirmation request from server
        .onReceive(voiceModel.$notificationFieldConfirmRequest) { req in
            guard let req else { return }
            pendingFieldConfirm = req
            correctedValue = req.proposedValue
            showFieldConfirmDialog = true
        }

        // NEW: finalize confirmation request from server
        .onReceive(voiceModel.$notificationFinalizeConfirmRequest) { req in
            guard let req else { return }
            pendingFinalizeConfirm = req
            showFinalizeConfirmSheet = true
        }

        // Gallery selection
        .onChange(of: galleryItems, initial: false) { _, items in
            guard !items.isEmpty else { return }
            Task { await handleGallerySelection(items) }
        }

        // Camera
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

        // QR
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

        // Photo viewer
        .sheet(item: $selectedPhoto) { photo in
            photoViewerSheet(photo)
        }

        // Logs sheet
        .sheet(isPresented: $showLogsSheet) {
            LogsSheetView(logs: voiceModel.logs)
        }

        // Field correction sheet
        .sheet(isPresented: $showFieldCorrectSheet) {
            NavigationStack {
                Form {
                    Section("Correct value") {
                        TextField("Value", text: $correctedValue)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }

                    if let req = pendingFieldConfirm {
                        Section("Field") {
                            Text(req.field)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .navigationTitle("Correct field")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { showFieldCorrectSheet = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Apply") {
                            guard let req = pendingFieldConfirm else { return }
                            Task {
                                await voiceModel.confirmNotificationField(
                                    requestId: req.requestId,
                                    accept: true,
                                    correctedValue: correctedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                                )
                                await MainActor.run {
                                    showFieldCorrectSheet = false
                                    showFieldConfirmDialog = false
                                    pendingFieldConfirm = nil
                                    voiceModel.clearNotificationFieldConfirmRequest()
                                }
                            }
                        }
                    }
                }
            }
        }

        // Field confirmation dialog (Confirm / Reject / Correct)
        .confirmationDialog(
            fieldConfirmTitle,
            isPresented: $showFieldConfirmDialog,
            titleVisibility: .visible
        ) {
            Button("Confirm") {
                guard let req = pendingFieldConfirm else { return }
                Task {
                    await voiceModel.confirmNotificationField(requestId: req.requestId, accept: true, correctedValue: nil)
                    await MainActor.run {
                        pendingFieldConfirm = nil
                        voiceModel.clearNotificationFieldConfirmRequest()
                    }
                }
            }

            Button("Correct…") {
                showFieldCorrectSheet = true
            }

            Button("Reject", role: .destructive) {
                guard let req = pendingFieldConfirm else { return }
                Task {
                    await voiceModel.confirmNotificationField(requestId: req.requestId, accept: false, correctedValue: nil)
                    await MainActor.run {
                        pendingFieldConfirm = nil
                        voiceModel.clearNotificationFieldConfirmRequest()
                    }
                }
            }

            Button("Cancel", role: .cancel) {
                // keep request pending; user can confirm later
            }
        } message: {
            if let req = pendingFieldConfirm {
                Text(req.readback)
            } else {
                Text("Confirm the value.")
            }
        }

        // Finalize confirmation sheet
        .sheet(isPresented: $showFinalizeConfirmSheet) {
            FinalizeConfirmationSheet(
                request: pendingFinalizeConfirm,
                fallbackDraft: wizard.draft,
                uploadInFlight: voiceModel.notificationUploadInFlight
            ) { accept in
                guard let req = pendingFinalizeConfirm else {
                    showFinalizeConfirmSheet = false
                    return
                }
                Task {
                    await voiceModel.confirmNotificationFinalize(requestId: req.requestId, accept: accept)
                    await MainActor.run {
                        showFinalizeConfirmSheet = false
                        pendingFinalizeConfirm = nil
                        voiceModel.clearNotificationFinalizeConfirmRequest()
                    }
                }
            }
        }
    }

    private var fieldConfirmTitle: String {
        guard let req = pendingFieldConfirm else { return "Confirm" }
        return "Confirm \(friendlyFieldName(req.field))"
    }

    private func friendlyFieldName(_ f: String) -> String {
        switch f {
        case "equipmentID": return "Equipment ID"
        case "functionalLocation": return "Functional Location"
        case "plant": return "Plant"
        case "priority": return "Priority"
        default: return f
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
        HStack(spacing: 12) {
            Image(systemName: voiceModel.isRunning ? "waveform.circle.fill" : "dot.circle")
                .foregroundColor(voiceModel.isRunning ? .green : .secondary)
                .font(.system(size: 22, weight: .bold))

            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications")
                    .font(.title3.bold())

                Text(voiceModel.status)
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            missingRequiredPill

            Button { showLogsSheet = true } label: {
                Image(systemName: "doc.plaintext")
                    .font(.system(size: 16, weight: .semibold))
            }
            .buttonStyle(.plain)
            .padding(8)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private var missingRequiredPill: some View {
        let missing = voiceModel.notificationMissingRequired.count
        let isReady = (missing == 0)

        return Text(isReady ? "Ready" : "\(missing) missing")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundColor(isReady ? .green : .orange)
            .background((isReady ? Color.green : Color.orange).opacity(0.12))
            .clipShape(Capsule())
    }

    private var uploadStatusBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            if voiceModel.notificationUploadInFlight {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Uploading / updating…")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                    Spacer()
                }
            }

            if let err = voiceModel.notificationUploadError, !err.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                    Text(err)
                        .font(.footnote)
                        .foregroundColor(.red)
                    Spacer()
                }
            }
        }
        .padding(12)
        .background(Color(.systemBackground))
        .cornerRadius(14)
        .shadow(color: .black.opacity(0.06), radius: 8, x: 0, y: 4)
    }

    private var manualEntryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Manual field entry")
                    .font(.headline)
                Spacer()
                Button { flushPendingFieldSync() } label: {
                    Label("Flush", systemImage: "arrow.up.circle")
                }
                .buttonStyle(.bordered)
            }

            fieldRow(title: "Notification Type") {
                TextField("e.g., PM01",
                          text: syncedBinding(field: "notificationType", keyPath: \.notificationType))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
            }

            fieldRow(title: "Short Text") {
                TextEditor(text: syncedBinding(field: "shortText", keyPath: \.shortText))
                    .frame(minHeight: 110)
                    .padding(8)
                    .background(Color(.secondarySystemGroupedBackground))
                    .cornerRadius(10)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.18)))
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
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 5)
    }

    private func fieldRow(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
            content()
        }
    }

    private var draftPhotosCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Draft photos").font(.headline)
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
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 5)
    }

    private var visionInsightsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Vision insights").font(.headline)
                Spacer()
                Text(voiceModel.notificationVisionResults.count.description)

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
                                Image(systemName: r.ok ? "sparkles" : "exclamationmark.triangle.fill")
                                    .foregroundColor(r.ok ? .accentColor : .orange)
                                Text(r.filename).font(.subheadline.weight(.semibold))
                                Spacer()
                                if let c = r.confidence {
                                    Text(String(format: "%.0f%%", (c * 100.0)))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }

                            if r.ok {
                                if let summary = r.summary, !summary.isEmpty {
                                    Text(summary).font(.caption)
                                }
                                if let labels = r.labels, !labels.isEmpty {
                                    Text("Labels: \(labels.prefix(10).joined(separator: ", "))")
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
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground))
                        .cornerRadius(14)
                    }
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 5)
    }

    private func photoThumb(_ photo: NotificationPhoto) -> some View {
        let url = photoURL(photo)

        return ZStack(alignment: .topTrailing) {
            Button { selectedPhoto = photo } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color(.secondarySystemGroupedBackground))
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
            HStack {
                Text("Notification draft").font(.headline)
                Spacer()

                Button {
                    flushPendingFieldSync()
                    Task { await voiceModel.requestFinalizeGate(source: "ui") }
                } label: {
                    Label("Review & Finalize", systemImage: "checkmark.seal")
                }
                .buttonStyle(.borderedProminent)
                .disabled(voiceModel.notificationUploadInFlight)
            }

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

            if !voiceModel.notificationLastActionSummary.isEmpty {
                Divider()
                Text(voiceModel.notificationLastActionSummary)
                    .font(.footnote)
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
            gridRow("Photos", "\(wizard.draft.photos.count)")
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 5)
    }

    private func gridRow(_ key: String, _ val: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(key)
                .font(.caption.weight(.semibold))
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
                    .background(Color(.secondarySystemGroupedBackground))
                    .cornerRadius(10)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.18)))
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 5)
    }

    private var startStopButton: some View {
        Button(action: {
            flushPendingFieldSync()
            voiceModel.isRunning ? voiceModel.stopConversation() : voiceModel.startConversation()
        }) {
            ZStack {
                Circle()
                    .fill(voiceModel.isRunning ? Color.red.opacity(0.9) : Color.accentColor.opacity(0.95))
                    .frame(width: 78, height: 78)
                    .shadow(color: .black.opacity(0.18), radius: 10, x: 0, y: 6)

                Image(systemName: voiceModel.isRunning ? "stop.fill" : "mic.fill")
                    .foregroundColor(.white)
                    .font(.system(size: 30, weight: .bold))
            }
        }
    }

    private var bottomAttachmentBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {

                Button {
                    pendingVoiceRequestId = nil
                    showCamera = true
                } label: {
                    bottomActionLabel(title: "Take photo", systemImage: "camera")
                }
                .buttonStyle(.plain)
                .disabled(voiceModel.notificationUploadInFlight)

                PhotosPicker(selection: $galleryItems, maxSelectionCount: 5, matching: .images) {
                    bottomActionLabel(title: "Gallery", systemImage: "photo.on.rectangle")
                }
                .buttonStyle(.plain)
                .disabled(voiceModel.notificationUploadInFlight)

                Button {
                    pendingQRRequestId = nil
                    showQRScanner = true
                } label: {
                    bottomActionLabel(title: "Scan QR", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.plain)
                .disabled(voiceModel.notificationUploadInFlight)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
        .overlay(Divider(), alignment: .top)
    }

    private func bottomActionLabel(title: String, systemImage: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
            Text(title)
                .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color.accentColor.opacity(0.12))
        .foregroundColor(.primary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
        for item in items {
            do {
                if let data = try await item.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    await handleCapturedImage(img, source: "manual")
                }
            } catch { }
        }
        await MainActor.run { self.galleryItems = [] }
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

private struct LogsSheetView: View {
    let logs: [String]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(logs.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.caption.monospaced())
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16)
            }
            .navigationTitle("Logs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct FinalizeConfirmationSheet: View {
    let request: NotificationFinalizeConfirmRequest?
    let fallbackDraft: NotificationDraft
    let uploadInFlight: Bool
    let onDone: (Bool) -> Void

    var body: some View {
        let draft = request?.draft ?? fallbackDraft
        let missing = request?.missingRequired ?? []

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {

                    Text(request?.reason ?? "Review before finalizing")
                        .font(.title3.bold())

                    if !missing.isEmpty {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                            Text("Missing required: \(missing.joined(separator: ", "))")
                                .font(.footnote)
                                .foregroundColor(.orange)
                        }
                        .padding(12)
                        .background(Color.orange.opacity(0.10))
                        .cornerRadius(12)
                    } else {
                        HStack(spacing: 10) {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundColor(.green)
                            Text("All required fields appear complete.")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                        .padding(12)
                        .background(Color.green.opacity(0.10))
                        .cornerRadius(12)
                    }

                    GroupBox("Notification data") {
                        VStack(alignment: .leading, spacing: 10) {
                            row("ID", draft.notificationId ?? "—")
                            row("Type", draft.notificationType ?? "—")
                            row("Short Text", draft.shortText ?? "—")
                            row("Priority", draft.priority ?? "—")
                            row("Equipment", draft.equipmentID ?? "—")
                            row("Functional Location", draft.functionalLocation ?? "—")
                            row("Plant", draft.plant ?? "—")
                            row("Reported By", draft.reportedBy ?? "—")
                            row("Photos", "\(draft.photos.count)")
                        }
                        .font(.footnote)
                    }

                    Text("Confirming will finalize and persist the notification on the server.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                .padding(16)
            }
            .navigationTitle("Confirm finalize")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { onDone(false) }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        onDone(true)
                    } label: {
                        if uploadInFlight {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Finalizing…")
                            }
                        } else {
                            Text("Confirm")
                        }
                    }
                    .disabled(uploadInFlight || !missing.isEmpty)
                }
            }
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(k)
                .foregroundColor(.secondary)
                .frame(width: 140, alignment: .leading)
            Text(v.isEmpty ? "—" : v)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
