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

const API_URL = process.env.API_URL;

const DEVICE_ID = process.env.DEVICE_ID;
// const API_URL = "https://dev-api-vpc.egoscue.com";
// const API_URL = "https://localhost:5001"


const CAMERA_API_URL = "https://localhost";

const servers = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    },
    {
      urls: "stun:stun.relay.metered.ca:80",
    }
  ],
  iceCandidatePoolSize: 10
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
  log("Connected to signalR");

  const deviceId = DEVICE_ID || await getDeviceId();

  signalRConnection.on(
    `ClientRequiresStream-${deviceId}`,
    async (sessionUuid) => {
      signalRConnection.on(
        `VerifiedAnswer-${sessionUuid}`,
        async (sessionUuid, answer) => {
          log(`Got an answer for uuid ${sessionUuid}`);
          const peerConnection = peerConnections.get(sessionUuid);
          const answerDescription = new RTCSessionDescription(
            JSON.parse(answer)
          );
          await peerConnection?.setRemoteDescription(answerDescription);
        }
      );

      signalRConnection.on(
        `VerifiedIceCandidateFrom-client-${sessionUuid}`,
        async (sessionUuid, candidate) => {
          log(`new candidate ${candidate} ${sessionUuid}`);
          try {
            const peerConnection = peerConnections.get(sessionUuid);
            const iceCandidate = new RTCIceCandidate(JSON.parse(candidate));
            await peerConnection?.addIceCandidate(iceCandidate);
          } catch (error) {
            console.error(`Error adding ICE candidate: ${error}`);
          }
        }
      );

      const peerConnection = new RTCPeerConnection(servers);

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          signalRConnection.invoke(
            "IceCandidate",
            sessionUuid,
            JSON.stringify(event.candidate),
            "server"
          );
        }
      };

      peerConnections.set(sessionUuid, peerConnection);

      setUpDataChannelApiInterface(peerConnection, sessionUuid);
      // setupDataChannelContinuousStream(peerConnection);

      peerConnection.createOffer().then((offer: any) => {
        log("Offer created");
        peerConnection.setLocalDescription(offer);
        signalRConnection.invoke("Offer", sessionUuid, JSON.stringify(offer));
      });
    }
  );
});

const setupDataChannel = (peerConnection, dataChannel) => {
  log(`peerConnection is ${peerConnection.connectionState}`);
  log(`piSendChannel is ${dataChannel.readyState}`);

  if (dataChannel?.readyState == "open") {
    dataChannel.send(`Counter is 1`);
  }
};

const setupDataChannelContinuousStream = async (
  peerConnection: RTCPeerConnection
) => {
  const channel = peerConnection.createDataChannel("piContinuousStream");
  // await fetch(`${CAMERA_API_URL}/stop`);
  // await fetch(`${CAMERA_API_URL}/start`);

  setInterval(async () => {
    if (channel.readyState == "open") {
      const response = await getCaptureFromApi();
      log(response);

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
  sessionUuid: string
) => {
  const cameraApiChannel = peerConnection.createDataChannel("cameraApiChannel");

  peerConnection.onconnectionstatechange = () => {
    log(
      `Connection number ${sessionUuid} state changed to ${peerConnection.connectionState}`
    );
    log(`Camera api channel is ${cameraApiChannel.readyState}`);
  };

  cameraApiChannel.onmessage = async (event) => {
    try {
      // log("Fetching url", event.data);
      const parsedMessage = JSON.parse(event.data);
      const response = await fetch(`${CAMERA_API_URL}${parsedMessage.path}`);
      const contentType = response.headers.get("content-type");

      if (contentType?.includes("text")) {
        const formattedResponse = {
          ok: response.ok,
          text: await response.text(),
        };
        log(`text response ${formattedResponse}`);
        cameraApiChannel.send(JSON.stringify(formattedResponse));
      } else if (contentType?.includes("json")) {
        const formattedResponse = {
          ok: response.ok,
          text: await response.text(),
        };
        cameraApiChannel.send(JSON.stringify(formattedResponse));
      } else if (contentType?.includes("image")) {
        const myBlob = await response.blob();
        const arrayBuffer = await myBlob.arrayBuffer();
        parsedMessage.chunk
          ? sendBufferInChunks(cameraApiChannel, arrayBuffer)
          : cameraApiChannel.send(arrayBuffer);
      } else if (contentType?.includes("octet-stream")) {
        const arrayBuffer = await response.arrayBuffer();
        parsedMessage.chunk
          ? sendBufferInChunks(cameraApiChannel, arrayBuffer)
          : cameraApiChannel.send(arrayBuffer);
      }
    } catch (e) {
      log(`ERROR ${e}`);
      if (cameraApiChannel.readyState === "open") {
        cameraApiChannel.send(JSON.stringify({ ok: false }));
      }
    }
  };

  cameraApiChannel.onclosing = (e) =>
    log(`Closing the data channel because + ${e}`);

  cameraApiChannel.onclose = (e) => log("Channel closed");

  cameraApiChannel.onerror = (e) => log("Channel error");

  cameraApiChannel.bufferedAmountLowThreshold = 1000 * 1024;

  cameraApiChannel.onbufferedamountlow = (e) =>
    log(`Buffer amount low ${e}`);
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
      return {
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
    log(`Device ID: ${deviceId}`);
    return deviceId;
  } else {
    log("Device ID not found");
    return null;
  }
};

const sendBufferInChunks = (
  dataChannel: RTCDataChannel,
  buffer: ArrayBuffer
) => {
  const chunkSize = 100 * 1024; // 100 KB
  let offset = 0;

  const uint8Array = new Uint8Array(buffer);

  while (offset < buffer.byteLength) {
    const chunk = uint8Array.subarray(offset, offset + chunkSize);
    offset += chunkSize;

    dataChannel.send(chunk);
  }

  dataChannel.send("Done");
};

const logSelectedCandidates = (peerConnection: RTCPeerConnection) => {
  peerConnection.getStats().then((stats) => {
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        log(`Selected candidate pair: ${report}`);
        log(`"Local candidate: ${stats.get(report.localCandidateId)}`);
        log(`Remote candidate: ${stats.get(report.remoteCandidateId)}`);
      }
    });
  });
};

const log = (message: any, level?: string) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};
