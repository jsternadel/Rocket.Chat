/* globals:CROWD:true */
/* eslint new-cap: [2, {"capIsNewExceptions": ["SHA256"]}] */
const logger = new Logger('CROWD', {});

function fallbackDefaultAccountSystem(bind, username, password) {
	if (typeof username === 'string') {
		if (username.indexOf('@') === -1) {
			username = {username};
		} else {
			username = {email: username};
		}
	}

	logger.info('Fallback to default account system', username);

	const loginRequest = {
		user: username,
		password: {
			digest: SHA256(password),
			algorithm: 'sha-256'
		}
	};

	return Accounts._runLoginHandlers(bind, loginRequest);
}

const CROWD = class CROWD {
	constructor() {
		const AtlassianCrowd = require('atlassian-crowd');
		let url = RocketChat.settings.get('CROWD_URL');

		this.options = {
			crowd: {
				base: (!/\/$/.test(url) ? url += '/' : url)
			},
			application: {
				name: RocketChat.settings.get('CROWD_APP_USERNAME'),
				password: RocketChat.settings.get('CROWD_APP_PASSWORD')
			},
			rejectUnauthorized: RocketChat.settings.get('CROWD_Reject_Unauthorized')
		};

		this.crowdClient = new AtlassianCrowd(this.options);

		this.crowdClient.user.authenticateSync = Meteor.wrapAsync(this.crowdClient.user.authenticate, this);
		this.crowdClient.user.findSync = Meteor.wrapAsync(this.crowdClient.user.find, this);
		this.crowdClient.searchSync = Meteor.wrapAsync(this.crowdClient.search, this);
		this.crowdClient.pingSync = Meteor.wrapAsync(this.crowdClient.ping, this);
	}

	checkConnection() {
		this.crowdClient.pingSync();
	}

	fetchCrowdUser(username) {
		const userResponse = this.crowdClient.user.findSync(username);

		return {
			displayname: userResponse['display-name'],
			username: userResponse.name,
			email: userResponse.email,
			active: userResponse.active
		};
	}

	authenticate(username, password) {
		if (!username || !password) {
			logger.error('No username or password');
			return;
		}

		logger.info('Going to crowd:', username);

		if (this.crowdClient.user.authenticateSync(username, password)) {

			const crowdUser = this.fetchCrowdUser(username);

			crowdUser.password = password;

			return crowdUser;
		}
	}

	syncDataToUser(crowdUser, id) {
		const user = {
			crowd_username: crowdUser.username,
			emails: [{
				address : crowdUser.email,
				verified: true
			}],
			active: crowdUser.active,
			crowd: true
		};

		if (crowdUser.password) {
			// this sets the password so it is encrypted and can be used
			// if Crowd is offline
			Accounts.setPassword(id, crowdUser.password, {
				logout: false
			});
		}

		if (crowdUser.displayname) {
			RocketChat._setRealName(id, crowdUser.displayname);
		}

		Meteor.users.update(id, {
			$set: user
		});
	}

	sync() {
		// if crowd is disabled bail out
		if (RocketChat.settings.get('CROWD_Enable') !== true) {
			return;
		}

		return new Promise((resolve, reject) => {

			const self = this;
			const users = RocketChat.models.Users.findCrowdUsers() || [];

			logger.info('Sync started...');

			users.forEach(function(user) {

				let username = user.hasOwnProperty('crowd_username') ? user.crowd_username : user.username;

				try {
					logger.info('Syncing user', username);

					const crowdUser = self.fetchCrowdUser(username);

					self.syncDataToUser(crowdUser, user._id);
					resolve();
				} catch (error) {
					logger.debug(error);
					logger.error('Could not sync user with username', username);

					const email = user.emails[0].address;
					logger.info('Attempting to find for user by email', email);

					const response = self.crowdClient.searchSync('user', `email=" ${ email } "`);
					if (response.users && response.users.length === 1) {
						username = response.users[0].name;
						logger.info('User found. Syncing user', username);

						const crowdUser = self.fetchCrowdUser(response.users[0].name);

						self.syncDataToUser(crowdUser, user._id);
						resolve();
					} else {
						reject();
						throw new Error('User does not exist or email is not unique');
					}
				}
			});
		});
	}

	// TODO: This should use the built in mechanism for creating usernames (UTF8_Names_Validation)
	// Crowd will allow emails as usernames which doesn't work very well in Rocket Chat
	// This mechanism works for a very limited set of use cases
	cleanUsername(username) {
		if (RocketChat.settings.get('CROWD_CLEAN_USERNAMES') === true) {
			return username.split('@')[0].toLowerCase();
		}
		return username;
	}

	updateUserCollection(crowdUser) {
		const userQuery = {
			crowd: true,
			username: crowdUser.username
		};

		// find our existing user if they exist
		const user = Meteor.users.findOne(userQuery);

		if (user) {
			const stampedToken = Accounts._generateStampedLoginToken();

			Meteor.users.update(user._id, {
				$push: {
					'services.resume.loginTokens': Accounts._hashStampedToken(stampedToken)
				}
			});

			this.syncDataToUser(crowdUser, user._id);

			return {
				userId: user._id,
				token: stampedToken.token
			};
		}

		// Attempt to create the new user
		try {
			// set a username that works with RocketChat
			crowdUser.username = this.cleanUsername(crowdUser.username);

			// create the user
			crowdUser._id = Accounts.createUser(crowdUser);

			// sync the user data
			this.syncDataToUser(crowdUser, crowdUser._id);

			return {
				userId: crowdUser._id
			};
		} catch (error) {
			logger.error('Error creating new crowd user.', error.message);
		}
	}
};

Accounts.registerLoginHandler('crowd', function(loginRequest) {
	if (loginRequest.crowd) {
		logger.info('Init CROWD login', loginRequest.username);

		if (RocketChat.settings.get('CROWD_Enable') !== true) {
			return fallbackDefaultAccountSystem(this, loginRequest.username, loginRequest.crowdPassword);
		}

		try {
			const crowd = new CROWD();
			const user = crowd.authenticate(loginRequest.username, loginRequest.crowdPassword);

			return crowd.updateUserCollection(user);
		} catch (error) {
			logger.debug(error);
			logger.error('Crowd user not authenticated due to an error, falling back');
			return fallbackDefaultAccountSystem(this, loginRequest.username, loginRequest.crowdPassword);
		}
	}
	return undefined;
});

let interval;
let timeout;

RocketChat.settings.get('CROWD_SYNC_INTERVAL', function(key, value) {
	Meteor.clearInterval(interval);

	logger.info('Setting CROWD sync interval to', value, 'minutes');

	const crowd = new CROWD();
	interval = Meteor.setInterval(function() {
		crowd.sync();
	}, value * 60 * 1000);
});

RocketChat.settings.get('CROWD_Sync_User_Data', function(key, value) {
	Meteor.clearInterval(interval);
	Meteor.clearTimeout(timeout);

	if (value === true) {
		const crowd = new CROWD();
		const syncInterval = RocketChat.settings.get('CROWD_SYNC_INTERVAL');

		logger.info('Enabling CROWD user sync');

		interval = Meteor.setInterval(function() {
			crowd.sync();
		}, syncInterval * 60 * 1000);

		timeout = Meteor.setTimeout(function() {
			crowd.sync();
		}, 1000 * 30);
	} else {
		logger.info('Disabling CROWD user sync');
	}
});

Meteor.methods({
	crowd_test_connection() {
		const user = Meteor.user();
		if (!user) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'crowd_test_connection' });
		}

		if (!RocketChat.authz.hasRole(user._id, 'admin')) {
			throw new Meteor.Error('error-not-authorized', 'Not authorized', { method: 'crowd_test_connection' });
		}

		if (RocketChat.settings.get('CROWD_Enable') !== true) {
			throw new Meteor.Error('crowd_disabled');
		}

		try {
			const crowd = new CROWD();
			crowd.checkConnection();

			return {
				message: 'Connection success',
				params: []
			};
		} catch (error) {
			logger.error('Invalid crowd connection details, check the url and application username/password and make sure this server is allowed to speak to crowd');
			throw new Meteor.Error('Invalid connection details', '', { method: 'crowd_test_connection' });
		}
	},
	crowd_sync_users() {
		const user = Meteor.user();
		if (RocketChat.settings.get('CROWD_Enable') !== true) {
			throw new Meteor.Error('crowd_disabled');
		}

		if (!RocketChat.authz.hasRole(user._id, 'admin')) {
			throw new Meteor.Error('error-not-authorized', 'Not authorized', { method: 'crowd_sync_users' });
		}

		try {
			const crowd = new CROWD();
			const startTime = (new Date()).valueOf();
			Promise.await(crowd.sync());
			const stopeTime = (new Date()).valueOf();
			const actual = Math.ceil((stopeTime - startTime) / 1000);

			return {
				message: `User data synced in ${ actual } seconds`,
				params: []
			};
		} catch (error) {
			logger.error('Error syncing user data. ', error.message);
			throw new Meteor.Error('Error syncing user data', '', { method: 'crowd_sync_users' });
		}
	}
});
