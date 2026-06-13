import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <SignUp
      signInUrl="/sign-in"
      fallbackRedirectUrl="/get-started"
      forceRedirectUrl="/get-started"
    />
  );
}
