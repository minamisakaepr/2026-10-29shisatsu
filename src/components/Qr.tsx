"use client";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

/** 受け取りコードの QR を表示する */
export function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 220 }).then(setSrc);
  }, [text]);
  return src ? <img src={src} alt="受け取りコードの QR" width={220} height={220} /> : null;
}

/** QR を読み取る（ブラウザが BarcodeDetector に対応していればカメラで、なければ手入力） */
export function QrScanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState("");
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window;

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
        while (!stop) {
          const codes = await detector.detect(video.current);
          const m = codes[0]?.rawValue?.match(/(\d{6})$/);
          if (m) {
            onCode(m[1]);
            setOn(false);
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch {
        setErr("カメラを使えませんでした。コードを手で入力してください");
        setOn(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on, onCode]);

  if (!supported) return null;
  return (
    <div className="stack">
      {on ? <video ref={video} style={{ width: "100%", borderRadius: 8 }} muted playsInline /> : (
        <button type="button" className="secondary" onClick={() => setOn(true)}>カメラで QR を読み取る</button>
      )}
      {err && <div className="msg error">{err}</div>}
    </div>
  );
}
