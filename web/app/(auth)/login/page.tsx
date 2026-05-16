import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const { callbackUrl, error } = await searchParams;
  const keycloakEnabled = !!process.env.KEYCLOAK_ISSUER;
  const target = callbackUrl ?? "/dashboard";
  return (
    <LoginForm
      callbackUrl={target}
      keycloakEnabled={keycloakEnabled}
      initialError={error}
    />
  );
}
