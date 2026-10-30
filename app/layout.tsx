import type { Metadata } from "next";
import "./globals.css";

// URL pública del sitio (enlaces para compartir y URL canónica). Se lee al compilar: `SITE_URL=https://... npm run build`.
const siteUrl = process.env.SITE_URL || "https://redoapp.dev";
const description = "Fix a shot without reshooting it. Reframe, remove objects, cut the pauses, upscale and remove the background with open models on Comfy Cloud.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Redo — Open Edit Video",
  description,
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: siteUrl, siteName: "Redo", title: "Redo — Open Edit Video", description },
  twitter: { card: "summary", title: "Redo — Open Edit Video", description },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
