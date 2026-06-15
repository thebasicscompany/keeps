import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

// Theme all Clerk widgets (SignIn/SignUp, the org-creation task,
// OrganizationSwitcher, PricingTable) to the keeps design system.
const clerkAppearance = {
  variables: {
    colorPrimary: "#14140F",
    colorText: "#14140F",
    colorTextSecondary: "#6F6F66",
    colorBackground: "#FAFAF8",
    colorInputBackground: "#FAFAF8",
    colorInputText: "#14140F",
    colorDanger: "#B42318",
    borderRadius: "4px",
    fontFamily: "var(--font-bricolage), ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    card: "border border-[#DEDED8] shadow-[0_24px_70px_rgba(20,20,15,0.07)]",
    formButtonPrimary:
      "bg-[#14140F] text-[#FAFAF8] hover:bg-[#26261f] normal-case font-semibold",
    footerActionLink: "text-[#1E6B4F] hover:text-[#14140F]",
  },
};

export const metadata: Metadata = {
  title: "Keeps",
  description: "Frictionless company intelligence for agentic teams.",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html
        lang="en"
        className={cn(geistSans.variable, geistMono.variable, bricolage.variable)}
      >
        <body className="bg-[#FAFAF8] font-[family-name:var(--font-bricolage)] text-[#14140F]">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
