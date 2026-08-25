# Azure Operations setup

Azure Operations uses open-quake's app-scoped OAuth 2.0 authorization-code flow with PKCE. The
app-local server receives the token, calls supported Azure Resource Manager APIs, and returns only
renderer-safe operational data.

## Microsoft Entra app registration

1. Create an app registration for work or school accounts. A single-tenant registration is the
   least-privilege default; use a multitenant registration only if this panel must reach subscriptions
   in several Microsoft Entra tenants.
2. Add a **Mobile and desktop applications** redirect URI of
   `http://localhost:5173/oauth/callback`. The host callback listener and port are fixed.
3. Under **API permissions**, add the delegated **Azure Service Management** permission
   `user_impersonation`. Grant tenant admin consent if local consent policy requires it.
4. Assign the signing-in user only the Azure RBAC roles needed at the subscriptions/resources the
   panel should operate. Reader is sufficient for dashboards; App Service or VM operations require
   the corresponding resource write permissions.
5. Copy the Application (client) ID into the app's open-quake settings. Leave Client secret blank for
   the recommended public-client registration. If policy requires a confidential-client registration,
   store its secret only in the secret option; open-quake encrypts it at rest and never sends it to the
   renderer.

The app requests `https://management.azure.com/user_impersonation` and `offline_access`. It does not
request Microsoft Graph or Azure DevOps permissions.
