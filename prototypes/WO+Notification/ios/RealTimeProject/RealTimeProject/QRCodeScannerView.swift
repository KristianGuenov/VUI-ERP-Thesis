import SwiftUI
import AVFoundation
import UIKit

// MARK: - SwiftUI wrapper

struct QRCodeScannerView: View {
    let onScanned: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            QRScannerRepresentable(onScanned: onScanned, onCancel: onCancel)
                .ignoresSafeArea()

            Button {
                onCancel()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(.white)
                    .shadow(radius: 4)
                    .padding()
            }
        }
    }
}

// MARK: - UIViewControllerRepresentable

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScanned: (String) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScanned = onScanned
        vc.onCancel = onCancel
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) { }
}

// MARK: - UIKit scanner controller

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {

    // Callbacks
    var onScanned: ((String) -> Void)?
    var onCancel: (() -> Void)?

    // Capture session + preview
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?

    // IMPORTANT: Dedicated queue for session operations
    private let sessionQueue = DispatchQueue(label: "qr.capture.session.queue", qos: .userInitiated)

    private var isConfigured = false
    private var didEmitResult = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Configure on background queue
        sessionQueue.async { [weak self] in
            self?.configureSessionIfNeeded()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)

        // Start running on background queue (fixes warning)
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.configureSessionIfNeeded()
            if self.isConfigured, !self.session.isRunning {
                self.session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)

        // Stop running on background queue
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    // MARK: - Session Configuration

    private func configureSessionIfNeeded() {
        guard !isConfigured else { return }

        // Camera permission check
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard let self else { return }
                if granted {
                    self.sessionQueue.async { self.configureSessionIfNeeded() }
                } else {
                    DispatchQueue.main.async {
                        self.onCancel?()
                    }
                }
            }
            return
        } else if status != .authorized {
            DispatchQueue.main.async { [weak self] in
                self?.onCancel?()
            }
            return
        }

        session.beginConfiguration()
        session.sessionPreset = .high

        // Input: back camera
        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            DispatchQueue.main.async { [weak self] in self?.onCancel?() }
            return
        }
        session.addInput(input)

        // Output: QR only
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            DispatchQueue.main.async { [weak self] in self?.onCancel?() }
            return
        }
        session.addOutput(output)

        // Delegate callback queue can be main; it only emits the result and dismisses UI.
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]

        session.commitConfiguration()
        isConfigured = true

        // Preview layer must be set up on main thread
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let layer = AVCaptureVideoPreviewLayer(session: self.session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = self.view.bounds
            self.view.layer.insertSublayer(layer, at: 0)
            self.previewLayer = layer
        }
    }

    // MARK: - AVCaptureMetadataOutputObjectsDelegate

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {

        guard !didEmitResult else { return }

        if let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
           obj.type == .qr,
           let raw = obj.stringValue,
           !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {

            didEmitResult = true

            // Stop capture on session queue
            sessionQueue.async { [weak self] in
                guard let self else { return }
                if self.session.isRunning { self.session.stopRunning() }
            }

            onScanned?(raw)
        }
    }
}
