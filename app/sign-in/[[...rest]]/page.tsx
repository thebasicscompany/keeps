import { SignIn } from "@clerk/nextjs";

// `forceRedirectUrl` always overrode the `redirect_url` query param, so signing
// in from a settings deep link (e.g. /sign-in?redirect_url=/settings) still
// dumped the user on onboarding. With only `fallbackRedirectUrl`, deep links
// return where you came from; a plain sign-in still lands on /get-started.
export default function SignInPage() {
  return (
    <SignIn
      signUpUrl="/sign-up"
      fallbackRedirectUrl="/get-started"
    />
  );
}
