import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-[#E7E5E4] px-5 py-12">
      <SignUp
        signInUrl="/sign-in"
        fallbackRedirectUrl="/get-started"
        forceRedirectUrl="/get-started"
      />
    </main>
  );
}
