import aedes from 'aedes';
import net from 'net';
const a = aedes({
	authorizePublish:
	Meteor.bindEnvironment(function(client, packet, callback) {
		const message = packet.payload.toString();
		RocketChat.sendMessage({ _id: 'rocket.cat', username: 'rocket.cat', name: 'rocket.cat' }, { msg: message }, { _id: packet.topic.replace('/room/', '') });
		callback(true);
	})
});

const server = net.createServer(a.handle);

const port = 1883;
Meteor.startup(function() {
	server.listen(port, function() {
		console.log('server listening on port', port);
	});
});

RocketChat.mqtt = a;

export default a;
