import { SignIn } from "@clerk/nextjs";

// `forceRedirectUrl` always overrode the `redirect_url` query param, so signing
// in from a settings deep link (e.g. /sign-in?redirect_url=/settings) still
// dumped the user on onboarding. With only `fallbackRedirectUrl`, deep links
// return where you came from; a plain sign-in still lands on /get-started.
export default function SignInPage() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-[#E7E5E4] px-5 py-12">
      <SignIn
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/get-started"
      />
    </main>
  );
}
