import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
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
    <Suspense>
      <GetStartedStepper sessionEmail={sessionEmail} />
    </Suspense>
  );
}
