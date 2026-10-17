#!/usr/bin/env python3
"""Generate independent TAK Protocol v1 byte fixtures for src/tak/protocol.

The JavaScript codec is hand-written. These fixtures come from a different
implementation: Google's protobuf runtime driving the published TAK message
descriptors packaged by `takproto` (MIT, https://github.com/snstac/takproto).
Every message is built field by field here; takproto's own XML conversion is
deliberately not used, so the fixtures test only the wire schema/framing.

    python3 -m pip install protobuf takproto==3.0.1
    python3 scripts/tak-proto-oracle.py > src/tak/protocol/takProtoOracle.mjs
    npm run format

Pass --takproto-path DIR to import an extracted takproto wheel instead.
All identities, callsigns and positions are synthetic.
"""

import argparse
import json
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--takproto-path")
args = parser.parse_args()
if args.takproto_path:
    sys.path.insert(0, args.takproto_path)

import google.protobuf  # noqa: E402
from takproto.constants import TAKProtoVer  # noqa: E402
from takproto.functions import msg2proto  # noqa: E402
from takproto.proto import TakMessage  # noqa: E402

T0 = 1791918000123  # 2026-10-13T19:00:00.123Z


def sa_full():
    m = TakMessage()
    e = m.cotEvent
    e.type = "a-f-G-U-C"
    e.uid = "ANDROID-0000synthetic01"
    e.how = "h-e"
    e.sendTime = T0
    e.startTime = T0
    e.staleTime = T0 + 360_000
    e.lat = 34.3665
    e.lon = -89.5192
    e.hae = 9999999.0
    e.ce = 9999999.0
    e.le = 9999999.0
    d = e.detail
    d.xmlDetail = '<uid Droid="VIPER"/>'
    d.contact.endpoint = "*:-1:stcp"
    d.contact.callsign = "VIPER"
    d.group.name = "Cyan"
    d.group.role = "Team Lead"
    d.precisionLocation.geopointsrc = "USER"
    d.precisionLocation.altsrc = "???"
    d.status.battery = 88
    d.takv.device = "SYNTHETIC PHONE"
    d.takv.platform = "ATAK-CIV"
    d.takv.os = "34"
    d.takv.version = "5.2.0.4 (synthetic).1730000000-CIV"
    d.track.speed = 1.2
    d.track.course = 30.5
    return m


def control_only():
    m = TakMessage()
    m.takControl.minProtoVersion = 1
    m.takControl.maxProtoVersion = 1
    m.takControl.contactUid = "ANDROID-0000synthetic01"
    return m


def chat_with_control():
    m = TakMessage()
    m.takControl.minProtoVersion = 1
    m.takControl.maxProtoVersion = 1
    m.takControl.contactUid = "ANDROID-0000synthetic01"
    e = m.cotEvent
    e.type = "b-t-f"
    e.uid = (
        "GeoChat.ANDROID-0000synthetic01.All Chat Rooms."
        "6c6b7a1e-0000-4000-8000-000000000001"
    )
    e.how = "h-g-i-g-o"
    e.sendTime = T0 + 60_000
    e.startTime = T0 + 60_000
    e.staleTime = T0 + 86_460_000
    e.lat = 34.3665
    e.lon = -89.5192
    e.hae = 9999999.0
    e.ce = 9999999.0
    e.le = 9999999.0
    e.detail.xmlDetail = (
        '<__chat parent="RootContactGroup" groupOwner="false" '
        'messageId="6c6b7a1e-0000-4000-8000-000000000001" '
        'chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="VIPER">'
        '<chatgrp uid0="ANDROID-0000synthetic01" uid1="All Chat Rooms" '
        'id="All Chat Rooms"/></__chat>'
        '<link uid="ANDROID-0000synthetic01" type="a-f-G-U-C" relation="p-p"/>'
        '<remarks source="BAO.F.ATAK.ANDROID-0000synthetic01" '
        'to="All Chat Rooms" time="2026-10-13T19:01:00.123Z">'
        "radio check &amp; comms ✓ señal \U0001f4e1</remarks>"
    )
    return m


def marker_minimal():
    m = TakMessage()
    e = m.cotEvent
    e.type = "b-m-p-s-m"
    e.uid = "SYNTH-MARKER-1"
    e.sendTime = 4102444800000  # 2100-01-01: a five-byte varint
    e.staleTime = 4102444800000 + 86_400_000
    e.lat = -33.8568
    e.lon = -0.0  # negative zero is not the proto3 default and is encoded
    e.hae = 12.25
    e.ce = 4.5
    e.le = 9999999.0
    return m


CASES = {
    "saFull": sa_full,
    "controlOnly": control_only,
    "chatWithControl": chat_with_control,
    "markerMinimal": marker_minimal,
}


def values(message):
    """Proto3 view of every schema field, matching decodeTakMessage()."""

    def scalar_or_message(msg):
        out = {}
        for field in msg.DESCRIPTOR.fields:
            if field.message_type:
                out[field.name] = (
                    scalar_or_message(getattr(msg, field.name))
                    if msg.HasField(field.name)
                    else None
                )
            else:
                value = getattr(msg, field.name)
                # JSON has no -0; the JS test checks the sign separately.
                out[field.name] = value
        return out

    return scalar_or_message(message)


def main():
    out = {}
    for name, build in CASES.items():
        message = build()
        payload = message.SerializeToString(deterministic=True)
        out[name] = {
            "payload": payload.hex(),
            "mesh": bytes(msg2proto(message, TAKProtoVer.MESH)).hex(),
            "stream": bytes(msg2proto(message, TAKProtoVer.STREAM)).hex(),
            "values": values(message),
        }
    print(
        "// GENERATED by scripts/tak-proto-oracle.py with Google protobuf "
        f"{google.protobuf.__version__}\n"
        "// and the takproto 3.0.1 TAK descriptors. Do not edit by hand.\n"
        "// Independent wire fixtures for the hand-written TAK Protocol v1 codec.\n"
        "// SYNTHETIC ONLY: identities, callsigns and positions are invented.\n"
    )
    print(f"export const TAK_PROTO_ORACLE = Object.freeze({json.dumps(out, indent=2, ensure_ascii=True)});")


if __name__ == "__main__":
    main()
