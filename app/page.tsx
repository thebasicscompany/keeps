import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import DotField from "./components/dot-field";
import { GetStartedStepper } from "./get-started-stepper";

async function resolveSessionEmail(): Promise<string | null> {
  const { userId } = await auth();

  if (!userId) {
    return null;
  }

  const [identity] = await getDb()
    .select({ email: userIdentities.email })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.provider, "clerk"), eq(userIdentities.providerAccountId, userId)),
    )
    .limit(1);

  return identity?.email ?? null;
}

export default async function HomePage() {
  const sessionEmail = await resolveSessionEmail();

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-[#FAFAF8]"
      >
        <DotField
          dotRadius={1.5}
          dotSpacing={14}
          bulgeStrength={67}
          glowRadius={160}
          sparkle={false}
          waveAmplitude={0}
          gradientFrom="rgba(20,20,15,0.18)"
          gradientTo="rgba(20,20,15,0.10)"
          glowColor="rgba(193,245,223,0.55)"
          className="absolute inset-0 h-full w-full"
        />
      </div>
      <Suspense>
        <GetStartedStepper sessionEmail={sessionEmail} />
      </Suspense>
    </>
  );
}
