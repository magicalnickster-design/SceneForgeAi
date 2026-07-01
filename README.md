# SceneForge AI

## Subscription auth flow (Discord)

SceneForge AI now uses Discord OAuth through the subscription backend.

1. Open **Foundry -> Game Settings -> Configure Settings -> Module Settings -> SceneForge AI**.
2. Click **Link Discord**.
3. Complete Discord sign-in.
4. Return to Foundry. SceneForge reads the callback hash and stores your session token.

The module then uses:

`Authorization: Bearer <stored-token>`

for generation requests to the subscription backend.

## Required backend URL

The backend base URL must be:

`https://sceneforge-backend.onrender.com`

## Migration note

Older worlds may still have a legacy token from prior Patreon/manual auth flows.
SceneForge keeps reading that legacy token for one release as fallback, but users should relink with Discord.
