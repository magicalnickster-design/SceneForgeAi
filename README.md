# SceneForge AI

## Subscription auth flow (Gambits Forge)

SceneForge AI uses Gambits Forge account authentication through the subscription backend.

1. Open **Foundry -> Game Settings -> Configure Settings -> Module Settings -> SceneForge AI**.
2. Click **Sign In**.
3. Enter your Gambits Forge email and password.
4. Return to Foundry and click **Sync Subscription** if needed.

The module then uses:

`Authorization: Bearer <stored-token>`

for generation requests to the subscription backend.

## Required backend URL

The backend base URL must be:

`https://sceneforge-backend.onrender.com`

## Account links

Forgot password and account creation are handled by:
`https://gambitsforge.online`
