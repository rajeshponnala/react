/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

var fs = require('fs');
var evalToString = require('../shared/evalToString');
var invertObject = require('./invertObject');

module.exports = function(babel) {
  var t = babel.types;

  var SEEN_SYMBOL = Symbol('replace-invariant-error-codes.seen');

  // Generate a hygienic identifier
  function getProdInvariantIdentifier(path, localState) {
    if (!localState.prodInvariantIdentifier) {
      localState.prodInvariantIdentifier = path.scope.generateUidIdentifier(
        'prodInvariant'
      );
      path.scope.getProgramParent().push({
        id: localState.prodInvariantIdentifier,
        init: t.callExpression(t.identifier('require'), [
          t.stringLiteral('shared/reactProdInvariant'),
        ]),
      });
    }
    return localState.prodInvariantIdentifier;
  }

  var DEV_EXPRESSION = t.identifier('__DEV__');

  return {
    pre: function() {
      this.prodInvariantIdentifier = null;
    },

    visitor: {
      CallExpression: {
        exit: function(path) {
          var node = path.node;
          // Ignore if it's already been processed
          if (node[SEEN_SYMBOL]) {
            return;
          }
          // Insert `var PROD_INVARIANT = require('reactProdInvariant');`
          // before all `require('invariant')`s.
          // NOTE it doesn't support ES6 imports yet.
          if (
            path.get('callee').isIdentifier({name: 'require'}) &&
            path.get('arguments')[0] &&
            path.get('arguments')[0].isStringLiteral({value: 'invariant'})
          ) {
            node[SEEN_SYMBOL] = true;
            getProdInvariantIdentifier(path, this);
          } else if (path.get('callee').isIdentifier({name: 'invariant'})) {
            // Turns this code:
            //
            // invariant(condition, argument, 'foo', 'bar');
            //
            // into this:
            //
            // if (!condition) {
            //   if ("production" !== process.env.NODE_ENV) {
            //     invariant(false, argument, 'foo', 'bar');
            //   } else {
            //     PROD_INVARIANT('XYZ', 'foo', 'bar');
            //   }
            // }
            //
            // where
            // - `XYZ` is an error code: a unique identifier (a number string)
            //   that references a verbose error message.
            //   The mapping is stored in `scripts/error-codes/codes.json`.
            // - `PROD_INVARIANT` is the `reactProdInvariant` function that always throws with an error URL like
            //   http://facebook.github.io/react/docs/error-decoder.html?invariant=XYZ&args[]=foo&args[]=bar
            //
            // Specifically this does 3 things:
            // 1. Checks the condition first, preventing an extra function call.
            // 2. Adds an environment check so that verbose error messages aren't
            //    shipped to production.
            // 3. Rewrites the call to `invariant` in production to `reactProdInvariant`
            //   - `reactProdInvariant` is always renamed to avoid shadowing
            // The generated code is longer than the original code but will dead
            // code removal in a minifier will strip that out.
            var condition = node.arguments[0];
            var errorMsgLiteral = evalToString(node.arguments[1]);

            var devInvariant = t.callExpression(
              node.callee,
              [
                t.booleanLiteral(false),
                t.stringLiteral(errorMsgLiteral),
              ].concat(node.arguments.slice(2))
            );

            devInvariant[SEEN_SYMBOL] = true;

            // Avoid caching because we write it as we go.
            var existingErrorMap = JSON.parse(
              fs.readFileSync(__dirname + '/codes.json', 'utf-8')
            );
            var errorMap = invertObject(existingErrorMap);

            var localInvariantId = getProdInvariantIdentifier(path, this);
            var prodErrorId = errorMap[errorMsgLiteral];
            var body = null;

            if (prodErrorId === undefined) {
              // The error wasn't found in the map.
              // This is only expected to occur on master since we extract codes before releases.
              // Keep the original invariant.
              body = t.expressionStatement(devInvariant);
            } else {
              var prodInvariant = t.callExpression(
                localInvariantId,
                [t.stringLiteral(prodErrorId)].concat(node.arguments.slice(2))
              );
              prodInvariant[SEEN_SYMBOL] = true;
              // The error was found in the map.
              // Switch between development and production versions depending on the env.
              body = t.ifStatement(
                DEV_EXPRESSION,
                t.blockStatement([t.expressionStatement(devInvariant)]),
                t.blockStatement([t.expressionStatement(prodInvariant)])
              );
            }

            path.replaceWith(
              t.ifStatement(
                t.unaryExpression('!', condition),
                t.blockStatement([body])
              )
            );
          }
        },
      },
    },
  };
};
