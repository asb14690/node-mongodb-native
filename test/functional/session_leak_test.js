'use strict';

const expect = require('chai').expect;
const sinon = require('sinon');
const core = require('mongodb-core');
const MongoClient = require('../../lib/mongo_client');
const ServerSessionPool = core.Sessions.ServerSessionPool;

(() => {
  const sandbox = sinon.createSandbox();

  let activeSessions, pooledSessions, activeSessionsBeforeClose;

  beforeEach('Session Leak Before Each - setup session tracking', function() {
    activeSessions = new Set();
    pooledSessions = new Set();
    activeSessionsBeforeClose = new Set();

    const _acquire = ServerSessionPool.prototype.acquire;
    sandbox.stub(ServerSessionPool.prototype, 'acquire').callsFake(function() {
      const session = _acquire.apply(this, arguments);
      activeSessions.add(session.id);
      // console.log(`Active + ${JSON.stringify(session.id)} = ${activeSessions.size}`);
      return session;
    });

    const _release = ServerSessionPool.prototype.release;
    sandbox.stub(ServerSessionPool.prototype, 'release').callsFake(function(session) {
      const id = session.id;
      activeSessions.delete(id);
      pooledSessions.add(id);
      return _release.apply(this, arguments);
    });

    [core.Server, core.ReplSet, core.Mongos].forEach(topology => {
      const _endSessions = topology.prototype.endSessions;
      sandbox.stub(topology.prototype, 'endSessions').callsFake(function(sessions) {
        sessions = Array.isArray(sessions) ? sessions : [sessions];

        sessions.forEach(id => pooledSessions.delete(id));

        return _endSessions.apply(this, arguments);
      });
    });

    const _close = MongoClient.prototype.close;
    sandbox.stub(MongoClient.prototype, 'close').callsFake(function() {
      activeSessionsBeforeClose = new Set(activeSessions);

      return _close.apply(this, arguments);
    });
  });

  afterEach('Session Leak After Each - ensure no leaks', function() {
    if (this.currentTest.state === 'failed') {
      return;
    }

    try {
      expect(
        activeSessionsBeforeClose.size,
        `test is leaking ${activeSessionsBeforeClose.size} active sessions while running client`
      ).to.equal(0);

      expect(
        activeSessions.size,
        `client close failed to clean up ${activeSessions.size} active sessions`
      ).to.equal(0);

      expect(
        pooledSessions.size,
        `client close failed to clean up ${pooledSessions.size} pooled sessions`
      ).to.equal(0);
    } catch (e) {
      this.test.error(e);
    }
  });

  afterEach('Session Leak After Each - restore sandbox', () => sandbox.restore());
  afterEach('Session Leak After Each - delete sets', () => {
    activeSessions = undefined;
    activeSessionsBeforeClose = undefined;
    pooledSessions = undefined;
  });
})();
