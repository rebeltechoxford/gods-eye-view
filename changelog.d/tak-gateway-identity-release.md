# TAK gateway: disconnected devices release their identity slot

- The gateway admits at most 32 distinct device identities at once, but it
  used to count every identity it had ever accepted. After 32 devices had
  connected over the server's lifetime (app reinstalls, cleared browser
  storage, new phones), every new device was refused until restart. An
  identity now frees its slot 10 minutes after its last connection closes.
  Within those 10 minutes a reconnect keeps the slot, and the device's own
  position heard back on the mesh (`TAK_MESH_LOOPBACK`) is still not taken
  as another device claiming that uid. Tabs sharing one identity hold it
  until the last one closes.
