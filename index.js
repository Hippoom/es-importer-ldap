let assert = require('assert');
let fs = require('fs')
let ldap = require('ldapjs');
let elasticsearch = require('elasticsearch');
let Joi = require('joi');

let schema = {
  ldap: {
    url: Joi.string().default('localhost:389'),
    bindDn: Joi.string().required(),
    bindCredentials: Joi.string().required(),
    searchBase: Joi.string().required(),
    searchFilter: Joi.string().default(
      '(&(objectCategory=person)(objectClass=user))'),
    usernameField: Joi.string().default('userPrincipalName'),
    adminGroup: Joi.string().default('Domain Admins')
  },
  elasticsearch: {
    hosts: Joi.array().items(Joi.string()).default(['localhost:9200'])
  }
};

let argv = require('minimist')(process.argv.slice(2));

let configValidationResult = Joi.validate(JSON.parse(fs.readFileSync(argv.c,
  'utf8')), schema);

if (configValidationResult.err) {
  console.log(err);
  process.exit(1);
}

let config = configValidationResult.value;

let ldapClient = ldap.createClient({
  url: config.ldap.url
});

let elasticsearchClient = elasticsearch.Client({
  hosts: config.elasticsearch.hosts
});


ldapClient.bind(config.ldap.bindDn,
  config.ldap.bindCredentials,
  function(err) {
    assert.ifError(err);
  }
);

let opts = {
  filter: config.ldap.searchFilter,
  scope: 'sub',
  attributes: [config.ldap.usernameField, 'memberOf']
};


ldapClient.search(
  config.ldap.searchBase,
  opts,
  function(err, res) {
    assert.ifError(err);

    res.on('searchEntry', function(entry) {
      // the user should look like this
      //{'username': <your username>, 'role': <admin|common>, 'enable': <0(disabled)|1(enabled)>}
      let username = entry.object[config.ldap.usernameField];
      if (username) {
        console.log('entry: ' + JSON.stringify(entry.object));

        let role = entry.object.memberOf &&
          entry.object.memberOf.includes(config.ldap.adminGroup) ?
          'admin' :
          'common';

        let user = {
          username: username,
          role: role,
          enable: 1
        };

        elasticsearchClient.count({
          index: '.kibana',
          type: 'users',
          q: 'username: "'+ user.username +'"'
        }, function(error, response) {
          console.log('response iis' + JSON.stringify(response));
          if (response.count == 0) {
            elasticsearchClient.index({
              index: '.kibana',
              type: 'users',
              id: user.username,
              body: {
                username: user.username,
                role: role,
                enable: 1
              }
            }, function(error, response) {
              console.log('response is' + JSON.stringify(response));
            });
          } else {
            elasticsearchClient.update({
              index: '.kibana',
              type: 'users',
              id: user.username,
              body: {
                doc: {
                  role: role
                }
              }
            }, function(error, response) {
              console.log('response is' + JSON.stringify(response));
            });
          }
        });
      }


    });
    res.on('searchReference', function(referral) {
      console.log('referral: ' + referral.uris.join());
    });
    res.on('error', function(err) {
      console.error('error: ' + err.message);
    });
    res.on('end', function(result) {
      console.log('status: ' + result.status);
      //TODO exit the scripts once search is done
      //process.exit();
    });
  });
