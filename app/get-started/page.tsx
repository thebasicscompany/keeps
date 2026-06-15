import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { GetStartedStepper } from "../get-started-stepper";
import { SecondaryHeader } from "../keeps-site-chrome";

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

export default async function GetStartedPage() {
  const sessionEmail = await resolveSessionEmail();

  return (
    <div className="keeps-page keeps-auth-page">
      <SecondaryHeader active="start" signedIn={Boolean(sessionEmail)} />
      <div aria-hidden="true" className="keeps-auth-background" />
      <Suspense>
        <GetStartedStepper sessionEmail={sessionEmail} />
      </Suspense>
    </div>
  );
}
