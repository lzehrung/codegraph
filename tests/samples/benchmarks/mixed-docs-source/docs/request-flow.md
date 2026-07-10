# Request flow

The local request pipeline starts at `sendRequest` in the [client source](../src/client.ts).
The client delegates request formatting to `formatRequest` in the [transport source](../src/transport.ts).
