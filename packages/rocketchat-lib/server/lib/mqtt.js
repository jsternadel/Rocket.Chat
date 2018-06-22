/* global DDP, DDPCommon */
import aedes from 'aedes';
import net from 'net';
const PORT = 1883;


const authorizePublish = Meteor.bindEnvironment(function(
	client,
	packet,
	callback
) {
	console.log(packet);
	// const message = packet.payload.toString();
	// RocketChat.sendMessage(
	// 	{ _id: 'rocket.cat', username: 'rocket.cat', name: 'rocket.cat' },
	// 	{ msg: message },
	// 	{ _id: packet.topic.replace('/room/', '') }
	// );
	callback(false, true);
});

const authenticate = Meteor.bindEnvironment(function(client, username, password, callback) {
	try {
		const invocation = new DDPCommon.MethodInvocation({
			connection: {
				close() {}
			}
		});
		const auth = DDP._CurrentInvocation.withValue(invocation, () =>{
			return Meteor.call('login', { user: { username }, password: password.toString()});
		});
		client.user = Meteor.users.findOne({ _id: auth.id });
		callback(null, !!client.user);
	} catch (error) {
		console.log(error);
		callback(error, !!client.user);
	}
});

const authorizeSubscribe = Meteor.bindEnvironment(function(client, sub, callback) {
	console.log('aqui');
	try {
		const { topic: rid } = sub;

		const subscription = RocketChat.models.Subscriptions.findOne({
			rid,
			'u._id': client.user._id
		});
		console.log(subscription);
		callback(null, sub);
	} catch (error) {
		console.log(error);
		callback(error);
	}
});

const a = aedes({
	authorizePublish,
	authenticate,
	authorizeSubscribe
});

const server = net.createServer(a.handle);

Meteor.startup(function() {
	server.listen(PORT, function() {
		console.log('server listening on port', PORT);
	});
});

RocketChat.mqtt = a;

export default a;
