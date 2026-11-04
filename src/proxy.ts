import { NextResponse, type NextRequest } from "next/server";

// Content Security Policy for pages, following node_modules/next/dist/docs/01-app/02-guides/
// content-security-policy.md. Scripts need this request's nonce. Styles allow inline
// attributes because React renders style props as attributes on the server. Images allow
// blob and data URLs for the local poster preview and the returned variant.
export function contentSecurityPolicy(nonce: string, options: { development: boolean; https: boolean }) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${options.development ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce, { development: process.env.NODE_ENV === "development", https: request.nextUrl.protocol === "https:" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [{
    source: "/((?!api|_next/static|_next/image|icon.svg|apple-icon.png|favicon.ico|samples/).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
