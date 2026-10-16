// Synthetic CoT shaped like real ATAK-CIV / WinTAK traffic. SYNTHETIC ONLY:
// uids, callsigns and positions are invented for tests. Shared by test files.

export const T0 = Date.parse('2026-10-13T19:00:00.000Z');

/** ATAK self SA (PPLI) with the detail block ATAK 5.x emits. */
export const ATAK_SA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><event version="2.0" uid="ANDROID-0000synthetic01" type="a-f-G-U-C" time="2026-10-13T19:00:00.123Z" start="2026-10-13T19:00:00.123Z" stale="2026-10-13T19:06:00.123Z" how="h-e"><point lat="34.3665" lon="-89.5192" hae="9999999.0" ce="9999999.0" le="9999999.0"/><detail><takv os="34" version="5.2.0.4 (synthetic).1730000000-CIV" device="SYNTHETIC PHONE" platform="ATAK-CIV"/><contact endpoint="*:-1:stcp" callsign="VIPER"/><uid Droid="VIPER"/><precisionlocation altsrc="???" geopointsrc="USER"/><__group role="Team Lead" name="Cyan"/><status battery="88"/><track course="30.5" speed="1.2"/></detail></event>`;

/** WinTAK hostile spot report with remarks and an unknown detail extension. */
export const WINTAK_HOSTILE = `<event version="2.0" uid="0b0b0b0b-1111-4222-8333-444444444444" type="a-h-G-U-C-I" how="h-g-i-g-o" time="2026-10-13T19:00:05Z" start="2026-10-13T19:00:05Z" stale="2026-10-13T20:00:05Z"><point lat="34.37" lon="-89.52" hae="120.5" ce="15" le="9999999"/><detail><contact callsign="H.1"/><link uid="S-1-5-21-synthetic" type="a-f-G-U-C" relation="p-p" parent_callsign="WINTAK-1" production_time="2026-10-13T19:00:05Z"/><remarks>Two vehicles &amp; dismounts</remarks><archive/><__milsym id="SHGPUCI----"/></detail></event>`;

/** ATAK GeoChat to All Chat Rooms. */
export const ATAK_CHAT = `<event version="2.0" uid="GeoChat.ANDROID-0000synthetic01.All Chat Rooms.6c6b7a1e-0000-4000-8000-000000000001" type="b-t-f" time="2026-10-13T19:01:00.000Z" start="2026-10-13T19:01:00.000Z" stale="2026-10-14T19:01:00.000Z" how="h-g-i-g-o"><point lat="34.3665" lon="-89.5192" hae="9999999.0" ce="9999999.0" le="9999999.0"/><detail><__chat parent="RootContactGroup" groupOwner="false" messageId="6c6b7a1e-0000-4000-8000-000000000001" chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="VIPER"><chatgrp uid0="ANDROID-0000synthetic01" uid1="All Chat Rooms" id="All Chat Rooms"/></__chat><link uid="ANDROID-0000synthetic01" type="a-f-G-U-C" relation="p-p"/><remarks source="BAO.F.ATAK.ANDROID-0000synthetic01" to="All Chat Rooms" time="2026-10-13T19:01:00.000Z">radio check</remarks></detail></event>`;

/** Delete of the hostile above. */
export const ATAK_DELETE = `<event version="2.0" uid="d3d3d3d3-0000-4000-8000-000000000002" type="t-x-d-d" time="2026-10-13T19:02:00Z" start="2026-10-13T19:02:00Z" stale="2026-10-13T19:02:20Z" how="h-g-i-g-o"><point lat="0" lon="0" hae="9999999" ce="9999999" le="9999999"/><detail><link uid="0b0b0b0b-1111-4222-8333-444444444444" relation="none" type="a-h-G-U-C-I"/><__forcedelete/></detail></event>`;

/** Air track with a real altitude. */
export const AIR_TRACK = `<event version="2.0" uid="SYNTH-AIR-1" type="a-n-A-C-F" time="2026-10-13T19:00:00Z" start="2026-10-13T19:00:00Z" stale="2026-10-13T19:01:00Z" how="m-g"><point lat="34.5" lon="-89.3" hae="3048" ce="30" le="30"/><detail><contact callsign="N123SY"/><track course="270" speed="120"/></detail></event>`;

/** Fixed identity for builder tests. */
export const IDENTITY = Object.freeze({
  uid: 'GEV-11111111-2222-4333-8444-555555555555',
  callsign: 'GODSEYE',
  team: 'Cyan',
  role: 'HQ',
});
