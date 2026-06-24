// A fake RTCPeerConnection whose data channel never opens, so UniclipClient
// stays on the relay (Node has no RTCPeerConnection; P2P/zero-internet is P4b).
export const disabledPeer = (): RTCPeerConnection =>
  ({
    onicecandidate: null, ondatachannel: null, onnegotiationneeded: null,
    onconnectionstatechange: null, signalingState: "stable", connectionState: "new",
    localDescription: null,
    createDataChannel: () => ({
      readyState: "connecting", send() {}, close() {},
      onopen: null, onclose: null, onmessage: null,
    }),
    createOffer: async () => ({ type: "offer", sdp: "" }),
    createAnswer: async () => ({ type: "answer", sdp: "" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {},
    addIceCandidate: async () => {}, close() {},
  }) as unknown as RTCPeerConnection;
