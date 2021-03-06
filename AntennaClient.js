let AntennaClient;
(function () {
	"use strict";
	Window.AudioContext = window.AudioContext || window.webkitAudioContext;
	let defaultOptions = {
		//ip: "ws://localhost:3001",
		ip: "tumble-room-vc.herokuapp.com",
		config: {
			iceServers: [
				{
					urls: ["stun:stun.l.google.com:19302"]
				}
			]
		},
		log: console.log,
		static: false
	};

	function setupNodeRoation(target) {
		let up = [0, 1, 0];
		let forward = [0, 0, -1];
		if (target.forwardX) {
			[
				target.forwardX.value,
				target.forwardY.value,
				target.forwardZ.value
			] = forward;
			[
				target.upX.value,
				target.forwardY.value,
				target.forwardZ.value
			] = forward;
		} else {
			target.setOrientation(...forward, ...up);
		}
	}

	function moniterDB(audioNode, audioContext = new AudioContext, cb) {
		if (audioNode.constructor.name == "MediaStream") audioNode = audioContext.createMediaStreamSource(audioNode);

		let anylyser = audioContext.createAnalyser(),
			javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

		anylyser.smoothingTimeConstant - 0.8;
		anylyser.fftSize = 1024;

		audioNode.connect(anylyser);
		anylyser.connect(javascriptNode);
		if (typeof out != "undefined") javascriptNode.connect(out);

		javascriptNode.addEventListener("audioprocess", () => {
			let array = new Uint8Array(anylyser.frequencyBinCount);
			anylyser.getByteFrequencyData(array);
			array.reduce((s, v) => s + v, 0);
			let values = 0;

			for (let value of array) {
				values += value;
			}
			cb(values / array.length);

		});
		return javascriptNode;
	}

	AntennaClient = class {
		constructor(options) {
			let { ip, config, log } = Object.assign(defaultOptions, options);
			this.log = log;
			this.ip = ip;
			this.peerConnections = {};
			this.peerPlayerIds = {};
			this.peerOutputs = {};
			this.config = config;

			this.devices = {
				input: null,
				output: null
			};
			this.settings = {
				gain: 1,
				inputId: "communications",
				outputId: "communications",
				onMicDB: _ => 0,
				onSpeakerDB: _ => 0
			};
			this.input = {
				audio: new Audio
			};

		}

		get omnipresent() {
			return !this.bcid;
		}

		getPlayer(id) {
			if (this.omnipresent || (!this.room && !this.world)) return;
			let room = this.world.room || this.room;
			if (!id) id = this.bcid;
			return room.playerCrumbs.find(p => p.i == id);
		}

		emit(...p) {
			if (this.socket) this.socket.emit(...p);
		}

		on(...p) {
			if (this.socket) this.socket.on(...p);
		}

		async createDot(id) {
			if (!this.world) return;
			if (!this.roomLoaded) await new Promise(resolve => setTimeout(resolve, 0));
			let players = this.world.stage.children[0].children[0].players;
			let player = players[id];
			let margin = 3;
			let circleRadius = 4.5;
			let circle = new createjs.Shape();
			let circleGraphics = circle.graphics;
			let colorCommand = circleGraphics.beginFill("grey").command;
			circleGraphics.drawCircle(0, 20, circleRadius);
			let name = player.nickname;
			let textWidth = name.children[0].getMeasuredWidth();
			name.addChild(circle);
			circle.x = -textWidth / 2 - circleRadius - margin;
			return {
				shape: circle,
				setColor: (color) => {
					colorCommand.style = color;
				},
				get style() { return colorCommand.style; }
			};
		}

		createPeerConnection(id, omnipresent) {
			let peerConnection = new RTCPeerConnection(this.config);
			this.peerConnections[id] = peerConnection;

			peerConnection.onicecandidate = event => {
				if (event.candidate) {
					this.emit("candidate", { id, candidate: event.candidate });
				}
			};
			//Setup Input Stream
			let inputStream = this.input.audio.srcObject;
			inputStream.getTracks().forEach(track => peerConnection.addTrack(track, inputStream));

			//Setup Output Stream
			peerConnection.ontrack = event => {
				let stream = new MediaStream;
				event.streams[0].getAudioTracks().forEach(track => stream.addTrack(track));
				// for some reason you have to stream peer connections to an audio element before you can do anything else to it
				{
					let audio = new Audio;
					audio.muted = true;
					audio.srcObject = stream;
					audio.play();
				}

				let audioContext = new AudioContext();
				setupNodeRoation(audioContext.listener);
				let source = audioContext.createMediaStreamSource(stream);
				let gain = audioContext.createGain();
				let panner = audioContext.createPanner();
				let destination = audioContext.createMediaStreamDestination();
				let audio = new Audio;

				source.connect(gain);
				gain.gain.value = this.settings.gain;

				let dbParams = [audioContext, db => this.peerOutputs[id].db = db];
				let dbMeasurer;
				if (omnipresent || this.omnipresent) {
					dbMeasurer = moniterDB(gain, ...dbParams);
					//gain.connect(destination);
				} else {
					//for Positioning
					setupNodeRoation(panner);
					dbMeasurer = moniterDB(gain, ...dbParams);
					//gain.connect(panner);
					panner.connect(destination);
					panner.coneInnerAngle = 360;
					panner.refDistance = 50;
					panner.rolloffFactor = 10;
					panner.distanceModel = "exponential";
					panner.panningModel = "HRTF";
				}

				dbMeasurer.connect(destination);
				audio.srcObject = destination.stream;
				//audio.src = URL.createObjectURL(destination.stream)
				audio.play();
				audio.setSinkId(this.settings.outputId);

				Object.assign(this.peerOutputs[id], {
					stream,
					source,
					gain,
					panner,
					audioContext,
					destination,
					audio,
				});
			};
			this.peerOutputs[id] = {};
			return peerConnection;
		}

		updateStatus({ id, status } = {}) {
			let target;
			if (id) {
				target = this.peerOutputs[id];
			} else {
				target = this;
				id = this.bcid;
				status = this.settings;
			}
			if (target.statusDot) target.statusDot.setColor(status.gain > 0 ? "green" : "red");
		}

		disconnectFromPeer(id) {
			if (!this.peerConnections[id]) return;
			this.peerConnections[id].close();
			delete this.peerConnections[id];
			if (!this.peerOutputs[id]) return;
			delete this.peerOutputs[id];
		}

		disconnectFromAllPeers() {
			for (let id in this.peerConnections) {
				this.disconnectFromPeer(id);
			}
		}

		login(world, id) {
			if (!world) return;
			this.world = world;
			this.bcid = id;
			this.emit("login", id);
		}

		joinRoom(room = this.room.roomId) {
			this.roomLoaded = false;
			this.disconnectFromAllPeers();
			if (!room.roomId) room = { roomId: room };
			this.emit("joinRoom", room.roomId);
			this.room = room;

			this.createDot(this.bcid).then(statusDot => {
				this.statusDot = statusDot;
				this.updateStatus();
			});
			setTimeout(_ => {
				this.setPosition();
				this.roomLoaded = true;
			}, 0);
		}

		close() {
			this.socket.close();
		}

		setupSockets() {
			this.socket = io.connect(this.ip);
			this.on("connect", () => {
				this.log("Connected to " + this.ip);
				if (this.room) {
					this.log("Rejoining " + this.room.roomId);
					this.joinRoom();
				}
			});
			this.on("peerConnect", async ({ id, bcid }) => {
				this.log(`Peer ${id} (${bcid || "omnipresent"}) has joined the room. Sending a peer to peer connection request to the new peer.`);
				let peerConnection = this.createPeerConnection(id, !bcid);
				peerConnection
					.createOffer()
					.then(sdp => peerConnection.setLocalDescription(sdp))
					.then(_ => {
						this.emit("request", { id, description: peerConnection.localDescription });
					});
				if (bcid) {
					this.peerPlayerIds[bcid] = id;
					this.peerOutputs[id].statusDot = await this.createDot(bcid);
					this.setPosition(this.getPlayer(bcid));
				}
			});
			this.on("request", async ({ id, bcid, description }) => {
				this.log(`Incoming connection request from ${id} (${bcid || "omnipresent"}) `, description);
				let peerConnection = this.createPeerConnection(id, !bcid);
				peerConnection
					.setRemoteDescription(description)
					.then(_ => peerConnection.createAnswer())
					.then(sdp => peerConnection.setLocalDescription(sdp))
					.then(_ => {
						this.emit("answer", { id, description: peerConnection.localDescription });
						this.emit("status", this.settings);
					});
				if (bcid) {
					this.peerPlayerIds[bcid] = id;
					this.peerOutputs[id].statusDot = await this.createDot(bcid);
					this.setPosition(this.getPlayer(bcid));
				}
			});

			// From New Peer to existing Peers
			this.on("answer", ({ id, description }) => {
				this.log(`Connection request to  ${id} has been answered:`, description);
				this.peerConnections[id].setRemoteDescription(description);
				this.emit("status", this.settings);
			});

			this.on("candidate", ({ id, candidate }) => {
				//this.log(`Candidate recived from ${id}:`, candidate)
				this.peerConnections[id]
					.addIceCandidate(new RTCIceCandidate(candidate))
					.catch(e => console.error(e));
			});

			this.on("peerDisconnect", id => {
				if (!this.peerConnections[id]) return;
				this.log(`Peer ${id} has left the room`);
				this.disconnectFromPeer(id);
			});

			this.on("status", ({ id, status }) => {
				this.updateStatus({ id, status });
			});
		}

		setNodePosition(target, pos) {
			this.log("Setting position for", pos);

			pos = [pos.x, 0, pos.y];

			if (target.positionX) {
				[
					target.positionX.value,
					target.positionY.value,
					target.positionZ.value
				] = pos;
			} else {
				target.setPosition(...pos);
			}
		}

		setPosition(info = this.getPlayer()) {
			if (this.omnipresent) return;
			let target;
			if (!info) return;
			if (info.i == this.bcid) {
				target = Object.values(this.peerOutputs).map(peer => peer.audioContext.listener);
			} else {
				let rtcID = this.peerPlayerIds[info.i];
				let peer = this.peerOutputs[rtcID];
				if (peer) target = peer.panner;
			}
			if (!target) return;
			if (Array.isArray(target)) {
				target.forEach(target => this.setNodePosition(target, info));
			} else {
				this.setNodePosition(target, info);
			}
		}

		setVolume(value) { this.setGain(value); }

		setGain(value) {
			this.settings.gain = value;
			Object.values(this.peerOutputs).forEach(peer => peer.gain.gain.value = value);
			this.updateStatus();
			this.emit("status", this.settings);
		}

		onMicDB(cb) {
			this.settings.onMicDB = cb;
		}

		onSpeakerDB(cb) {
			this.settings.onSpeakerDB = _ => cb(this.peerOutputs.reduce((s, p) => s + p.db, 0) / this.peerOutputs.length);
		}

		setSpeaker(deviceId = "communications") {
			this.settings.outputId = deviceId;
			Object.values(this.peerOutputs).forEach(peer => {
				console.log(peer.audio, deviceId);
				peer.audio.setSinkId(deviceId);
			});
		}


		setMicrophone(deviceId = "communications") {
			this.settings.inputId = deviceId;
			//Media Constaints
			const constraints = {
				audio: { deviceId }
			};

			return new Promise((resolve, reject) => {
				navigator.mediaDevices
					.getUserMedia(constraints)
					.then(stream => {
						this.log("Connected to Microphone", stream);
						var audioContext = new AudioContext;
						var micOutput = moniterDB(stream, audioContext, db => {
							this.input.db = db;
							this.settings.onMicDB(db);
						});
						var destination = audioContext.createMediaStreamDestination();
						micOutput.connect(destination);
						this.devices.input = destination.stream;

						this.input.audio.srcObject = stream;
						resolve();
					})
					.catch(error => this.log(error));

			});
		}

		async getDevices(kind = "input") {
			let devices = await navigator.mediaDevices.enumerateDevices();
			return devices.filter(device => device.kind == "audio" + kind);
		}
	};
})();