import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
} from "@microsoft/signalr";
import sharp from "sharp";
const { RTCVideoSource, RTCVideoSink, rgbaToI420 } =
  require("wrtc").nonstandard;
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from "wrtc";

const API_URL = "https://dev-api-vpc.egoscue.com";
// const API_URL = "https://localhost:5001";

const CAMERA_API_URL = "https://localhost";

const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.1.google.com:19302", "stun:stun2.1.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

let exposure = 300;

const signalRConnection = new HubConnectionBuilder()
  .withUrl(`${API_URL}/hubs/v1/depthCameraHub`, {
    withCredentials: false,
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
  })
  .withAutomaticReconnect()   
  .build();

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const peerConnections = new Map<string, RTCPeerConnection>();

signalRConnection.start().then(async () => {
  console.log("Connected to signalR");

  const deviceId = await getDeviceId() || "100000001d638428";
  
  signalRConnection.on(
    `ClientRequiresStream-${deviceId}`,
    async (sessionUuid) => {
      signalRConnection.on(
        `VerifiedAnswer-${sessionUuid}`,
        async (sessionUuid, answer) => {
          console.log(`Got an answer for uuid ${sessionUuid}`);
          const peerConnection = peerConnections.get(sessionUuid);
          const answerDescription = new RTCSessionDescription(
            JSON.parse(answer)
          );
          await peerConnection?.setRemoteDescription(answerDescription);
        }
      );

      signalRConnection.on(
        `VerifiedIceCandidate-${sessionUuid}`,
        async (sessionUuid, candidate) => {
          console.log("new candidate", candidate, sessionUuid);
          try {
            const peerConnection = peerConnections.get(sessionUuid);
            const iceCandidate = new RTCIceCandidate(JSON.parse(candidate));
            await peerConnection?.addIceCandidate(iceCandidate);
          } catch (error) {
            console.error("Error adding ICE candidate:", error);
          }
        }
      );

      const peerConnection = new RTCPeerConnection(servers);

      console.log("Peer connection", peerConnection);

      peerConnections.set(sessionUuid, peerConnection);

      setUpDataChannelApiInterface(
        peerConnection,
        signalRConnection,
        sessionUuid
      );
      // setupDataChannelContinuousStream(peerConnection);

      peerConnection.createOffer().then((offer: any) => {
        console.log("Offer created");
        peerConnection.setLocalDescription(offer);
        signalRConnection.invoke("Offer", sessionUuid, JSON.stringify(offer));
      });
    }
  );
});

const setupDataChannel = (peerConnection, dataChannel) => {
  console.log("peerConnection is", peerConnection.connectionState);
  console.log("piSendChannel is", dataChannel.readyState);

  if (dataChannel?.readyState == "open") {
    dataChannel.send(`Counter is 1`);
  }
};

const setupDataChannelContinuousStream = async (
  peerConnection: RTCPeerConnection
) => {
  console.log("GOT HERE");
  const channel = peerConnection.createDataChannel("piContinuousStream");
  // await fetch(`${CAMERA_API_URL}/stop`);
  // await fetch(`${CAMERA_API_URL}/start`);

  setInterval(() => {
    console.log("peerConnection is", peerConnection.connectionState);
    console.log("piContinuousStream is", channel.readyState);
  }, 1000);

  setInterval(async () => {
    if (channel.readyState == "open") {
      const response = await getCaptureFromApi();
      console.log(response);

      if (response.image === null) {
        // TODO: error count
        return;
      }

      channel.send(response.image);
    }
  }, 80);
};

const setUpDataChannelApiInterface = async (
  peerConnection: RTCPeerConnection,
  signalRConnection: HubConnection,
  sessionUuid: string
) => {
  const cameraApiChannel = peerConnection.createDataChannel("cameraApiChannel");

  setInterval(() => {
    console.log("peerConnection is", peerConnection.connectionState);
    console.log("cameraApiChannel is", cameraApiChannel.readyState);
  }, 1000);

  cameraApiChannel.onmessage = async (event) => {
    try {
      console.log("Fetching url", event.data);
      const response = await fetch(`${CAMERA_API_URL}${event.data}`);
      const contentType = response.headers.get("content-type");

      if (contentType?.includes("text")) {
        const formattedResponse = {
          ok: response.ok,
          data: await response.text(),
        };
        console.log("text response", formattedResponse);
        cameraApiChannel.send(JSON.stringify(formattedResponse));
      } else if (contentType?.includes("json")) {
        const formattedResponse = {
          ok: response.ok,
          data: await response.json(),
        };
        cameraApiChannel.send(JSON.stringify(formattedResponse));
      } else if (contentType?.includes("image")) {
        const myBlob = await response.blob();
        cameraApiChannel.send(await myBlob.arrayBuffer());
      } else if (contentType?.includes("octet-stream")) {
        cameraApiChannel.send(await response.arrayBuffer());
      }
    } catch (e) {
      console.log("ERROR", e);
      if (cameraApiChannel.readyState === "open") {
        cameraApiChannel.send(JSON.stringify({ ok: false }));
      }
    }
  };

  cameraApiChannel.onclosing = (e) =>
    console.log("Closing the data channel because" + e);

  cameraApiChannel.onclose = (e) => console.log("Channel closed", e);

  cameraApiChannel.onerror = (e) => console.log("Channel error", e);

  signalRConnection.on(
    `CameraApiRequest-${sessionUuid}`,
    async (sessionUuid, url: string) => {
      
      console.log('Got request url');
      try {
        console.log("Fetching url", url);
        const response = await fetch(`${CAMERA_API_URL}${url}`);
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("text")) {
          console.log('Text Response');
          signalRConnection.invoke(
            "CameraApiResponse",
            sessionUuid,
            response.ok,
            await response.text(),
            null
          );
        } else if (contentType?.includes("image")) {
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          signalRConnection.invoke(
            "CameraApiResponse",
            sessionUuid,
            response.ok,
            null,
            base64
          );
        } else if (contentType?.includes("octet-stream")) {
          console.log('Buffer response');
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          console.log('buffer', buffer);
          signalRConnection.invoke(
            "CameraApiResponse",
            sessionUuid,
            response.ok,
            null,
            base64
          );
        }
      } catch (e) {
        console.log('Error catched')
        signalRConnection.invoke(
          "CameraApiResponse",
          sessionUuid,
          false,
          null,
          null
        );
      }
    }
  );
};

const setupMediaChannelStream = async (peerConnection: RTCPeerConnection) => {
  const source = new RTCVideoSource();
  const track = source.createTrack();
  const transceiver = peerConnection.addTransceiver(track);
  new RTCVideoSink(transceiver.receiver.track);

  // const image = getImageAsBuffer(fileNumber);
  const capture = await getCaptureFromApi();

  if (capture.image === null) {
    // TODO: set up error count
    return;
  }

  const { data, info } = await sharp(capture.image)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const rgbaData = new Uint8ClampedArray(data);
  const i420Data = new Uint8ClampedArray(info.width * info.height * 1.5);
  const rgbaFrame = { width: info.width, height: info.height, data: rgbaData };
  const i420Frame = { width: info.width, height: info.height, data: i420Data };

  rgbaToI420(rgbaFrame, i420Frame);

  source.onFrame(i420Frame);
};

const setUpDummyChannelStream = (peerConnection: RTCPeerConnection) => {
  // Without the creation of this dummy data channel, the connection doesn't work, and I don't have access to the pi channel
  const piSendChannel = peerConnection.createDataChannel("piSendChannel");
  setInterval(() => setupDataChannel(peerConnection, piSendChannel), 1000);
};

const getCaptureFromApi = async () => {
  try {
    const response = await fetch(
      `${CAMERA_API_URL}/capture?shrink=0.3&exposure=${exposure}`
    );
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("image")) {
      return await {
        image: await response.arrayBuffer(),
        ok: true,
        error: null,
      };
    } else if (contentType?.includes("text")) {
      return { image: null, ok: false, error: await response.text() };
    }
    return { image: null, ok: false, error: null };
  } catch (e) {
    return { image: null, ok: false, error: e };
  }
};

const getDeviceId = async () => {
  const response = await fetch("http://localhost");
  const htmlString = await response.text();

  const pattern = /value="(\d+\w+)"/;
  const match = htmlString.match(pattern);

  if (match && match[1]) {
    const deviceId = match[1];
    console.log("Device ID:", deviceId);
    return deviceId;
  } else {
    console.log("Device ID not found");
    return null;
  }
};
