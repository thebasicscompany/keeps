import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params.
    // Also exclude webhook/inngest endpoints that must run without Clerk auth.
    "/((?!_next|api/email/inbound|api/inngest|api/auth/clerk/webhook|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for the remaining API routes.
    "/(api(?!/email/inbound|/inngest|/auth/clerk/webhook)(?:/.*)?)",
  ],
};
