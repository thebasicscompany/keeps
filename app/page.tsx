import { getDevSession } from "@/auth/dev-session";
import { GetStartedStepper } from "./get-started-stepper";

export default async function HomePage() {
  const session = await getDevSession();

  return <GetStartedStepper sessionEmail={session?.email ?? null} />;
}
