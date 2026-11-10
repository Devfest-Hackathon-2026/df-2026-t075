import { GoogleSignIn } from "@/client/components/google-sign-in";
import { Landing } from "@/client/components/landing";
import { getSignInConfig } from "@/server/composition/auth.server";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const config = getSignInConfig();
  return (
    <Landing>
      {config ? (
        <GoogleSignIn config={config} />
      ) : (
        <p>現在、Googleログインを利用できません。</p>
      )}
    </Landing>
  );
}
