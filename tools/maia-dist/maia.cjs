#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/chess.js/dist/cjs/chess.js
var require_chess = __commonJS({
  "node_modules/chess.js/dist/cjs/chess.js"(exports2) {
    "use strict";
    function rootNode(comment) {
      return comment !== null ? { comment, variations: [] } : { variations: [] };
    }
    function node(move, suffix, nag, comment, variations) {
      const node2 = { move, variations };
      if (suffix) {
        node2.suffix = suffix;
      }
      if (nag) {
        node2.nag = nag;
      }
      if (comment !== null) {
        node2.comment = comment;
      }
      return node2;
    }
    function lineToTree(...nodes) {
      const [root, ...rest] = nodes;
      let parent = root;
      for (const child of rest) {
        if (child !== null) {
          parent.variations = [child, ...child.variations];
          child.variations = [];
          parent = child;
        }
      }
      return root;
    }
    function pgn(headers, game) {
      if (game.marker && game.marker.comment) {
        let node2 = game.root;
        while (true) {
          const next = node2.variations[0];
          if (!next) {
            node2.comment = game.marker.comment;
            break;
          }
          node2 = next;
        }
      }
      return {
        headers,
        root: game.root,
        result: (game.marker && game.marker.result) ?? void 0
      };
    }
    function peg$subclass(child, parent) {
      function C() {
        this.constructor = child;
      }
      C.prototype = parent.prototype;
      child.prototype = new C();
    }
    function peg$SyntaxError(message, expected, found, location) {
      var self = Error.call(this, message);
      if (Object.setPrototypeOf) {
        Object.setPrototypeOf(self, peg$SyntaxError.prototype);
      }
      self.expected = expected;
      self.found = found;
      self.location = location;
      self.name = "SyntaxError";
      return self;
    }
    peg$subclass(peg$SyntaxError, Error);
    function peg$padEnd(str, targetLength, padString) {
      padString = padString || " ";
      if (str.length > targetLength) {
        return str;
      }
      targetLength -= str.length;
      padString += padString.repeat(targetLength);
      return str + padString.slice(0, targetLength);
    }
    peg$SyntaxError.prototype.format = function(sources) {
      var str = "Error: " + this.message;
      if (this.location) {
        var src = null;
        var k;
        for (k = 0; k < sources.length; k++) {
          if (sources[k].source === this.location.source) {
            src = sources[k].text.split(/\r\n|\n|\r/g);
            break;
          }
        }
        var s = this.location.start;
        var offset_s = this.location.source && typeof this.location.source.offset === "function" ? this.location.source.offset(s) : s;
        var loc = this.location.source + ":" + offset_s.line + ":" + offset_s.column;
        if (src) {
          var e = this.location.end;
          var filler = peg$padEnd("", offset_s.line.toString().length, " ");
          var line = src[s.line - 1];
          var last = s.line === e.line ? e.column : line.length + 1;
          var hatLen = last - s.column || 1;
          str += "\n --> " + loc + "\n" + filler + " |\n" + offset_s.line + " | " + line + "\n" + filler + " | " + peg$padEnd("", s.column - 1, " ") + peg$padEnd("", hatLen, "^");
        } else {
          str += "\n at " + loc;
        }
      }
      return str;
    };
    peg$SyntaxError.buildMessage = function(expected, found) {
      var DESCRIBE_EXPECTATION_FNS = {
        literal: function(expectation) {
          return '"' + literalEscape(expectation.text) + '"';
        },
        class: function(expectation) {
          var escapedParts = expectation.parts.map(function(part) {
            return Array.isArray(part) ? classEscape(part[0]) + "-" + classEscape(part[1]) : classEscape(part);
          });
          return "[" + (expectation.inverted ? "^" : "") + escapedParts.join("") + "]";
        },
        any: function() {
          return "any character";
        },
        end: function() {
          return "end of input";
        },
        other: function(expectation) {
          return expectation.description;
        }
      };
      function hex(ch) {
        return ch.charCodeAt(0).toString(16).toUpperCase();
      }
      function literalEscape(s) {
        return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\0/g, "\\0").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\x00-\x0F]/g, function(ch) {
          return "\\x0" + hex(ch);
        }).replace(/[\x10-\x1F\x7F-\x9F]/g, function(ch) {
          return "\\x" + hex(ch);
        });
      }
      function classEscape(s) {
        return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\^/g, "\\^").replace(/-/g, "\\-").replace(/\0/g, "\\0").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\x00-\x0F]/g, function(ch) {
          return "\\x0" + hex(ch);
        }).replace(/[\x10-\x1F\x7F-\x9F]/g, function(ch) {
          return "\\x" + hex(ch);
        });
      }
      function describeExpectation(expectation) {
        return DESCRIBE_EXPECTATION_FNS[expectation.type](expectation);
      }
      function describeExpected(expected2) {
        var descriptions = expected2.map(describeExpectation);
        var i, j;
        descriptions.sort();
        if (descriptions.length > 0) {
          for (i = 1, j = 1; i < descriptions.length; i++) {
            if (descriptions[i - 1] !== descriptions[i]) {
              descriptions[j] = descriptions[i];
              j++;
            }
          }
          descriptions.length = j;
        }
        switch (descriptions.length) {
          case 1:
            return descriptions[0];
          case 2:
            return descriptions[0] + " or " + descriptions[1];
          default:
            return descriptions.slice(0, -1).join(", ") + ", or " + descriptions[descriptions.length - 1];
        }
      }
      function describeFound(found2) {
        return found2 ? '"' + literalEscape(found2) + '"' : "end of input";
      }
      return "Expected " + describeExpected(expected) + " but " + describeFound(found) + " found.";
    };
    function peg$parse(input, options) {
      options = options !== void 0 ? options : {};
      var peg$FAILED = {};
      var peg$source = options.grammarSource;
      var peg$startRuleFunctions = { pgn: peg$parsepgn };
      var peg$startRuleFunction = peg$parsepgn;
      var peg$c0 = "[";
      var peg$c1 = '"';
      var peg$c2 = "]";
      var peg$c3 = ".";
      var peg$c4 = "O-O-O";
      var peg$c5 = "O-O";
      var peg$c6 = "0-0-0";
      var peg$c7 = "0-0";
      var peg$c8 = "$";
      var peg$c9 = "{";
      var peg$c10 = "}";
      var peg$c11 = ";";
      var peg$c12 = "(";
      var peg$c13 = ")";
      var peg$c14 = "1-0";
      var peg$c15 = "0-1";
      var peg$c16 = "1/2-1/2";
      var peg$c17 = "*";
      var peg$r0 = /^[a-zA-Z]/;
      var peg$r1 = /^[^"]/;
      var peg$r2 = /^[0-9]/;
      var peg$r3 = /^[.]/;
      var peg$r4 = /^[a-zA-Z1-8\-=]/;
      var peg$r5 = /^[+#]/;
      var peg$r6 = /^[!?]/;
      var peg$r7 = /^[^}]/;
      var peg$r8 = /^[^\r\n]/;
      var peg$r9 = /^[ \t\r\n]/;
      var peg$e0 = peg$otherExpectation("tag pair");
      var peg$e1 = peg$literalExpectation("[", false);
      var peg$e2 = peg$literalExpectation('"', false);
      var peg$e3 = peg$literalExpectation("]", false);
      var peg$e4 = peg$otherExpectation("tag name");
      var peg$e5 = peg$classExpectation([["a", "z"], ["A", "Z"]], false, false);
      var peg$e6 = peg$otherExpectation("tag value");
      var peg$e7 = peg$classExpectation(['"'], true, false);
      var peg$e8 = peg$otherExpectation("move number");
      var peg$e9 = peg$classExpectation([["0", "9"]], false, false);
      var peg$e10 = peg$literalExpectation(".", false);
      var peg$e11 = peg$classExpectation(["."], false, false);
      var peg$e12 = peg$otherExpectation("standard algebraic notation");
      var peg$e13 = peg$literalExpectation("O-O-O", false);
      var peg$e14 = peg$literalExpectation("O-O", false);
      var peg$e15 = peg$literalExpectation("0-0-0", false);
      var peg$e16 = peg$literalExpectation("0-0", false);
      var peg$e17 = peg$classExpectation([["a", "z"], ["A", "Z"], ["1", "8"], "-", "="], false, false);
      var peg$e18 = peg$classExpectation(["+", "#"], false, false);
      var peg$e19 = peg$otherExpectation("suffix annotation");
      var peg$e20 = peg$classExpectation(["!", "?"], false, false);
      var peg$e21 = peg$otherExpectation("NAG");
      var peg$e22 = peg$literalExpectation("$", false);
      var peg$e23 = peg$otherExpectation("brace comment");
      var peg$e24 = peg$literalExpectation("{", false);
      var peg$e25 = peg$classExpectation(["}"], true, false);
      var peg$e26 = peg$literalExpectation("}", false);
      var peg$e27 = peg$otherExpectation("rest of line comment");
      var peg$e28 = peg$literalExpectation(";", false);
      var peg$e29 = peg$classExpectation(["\r", "\n"], true, false);
      var peg$e30 = peg$otherExpectation("variation");
      var peg$e31 = peg$literalExpectation("(", false);
      var peg$e32 = peg$literalExpectation(")", false);
      var peg$e33 = peg$otherExpectation("game termination marker");
      var peg$e34 = peg$literalExpectation("1-0", false);
      var peg$e35 = peg$literalExpectation("0-1", false);
      var peg$e36 = peg$literalExpectation("1/2-1/2", false);
      var peg$e37 = peg$literalExpectation("*", false);
      var peg$e38 = peg$otherExpectation("whitespace");
      var peg$e39 = peg$classExpectation([" ", "	", "\r", "\n"], false, false);
      var peg$f0 = function(headers, game) {
        return pgn(headers, game);
      };
      var peg$f1 = function(tagPairs) {
        return Object.fromEntries(tagPairs);
      };
      var peg$f2 = function(tagName, tagValue) {
        return [tagName, tagValue];
      };
      var peg$f3 = function(root, marker) {
        return { root, marker };
      };
      var peg$f4 = function(comment, moves) {
        return lineToTree(rootNode(comment), ...moves.flat());
      };
      var peg$f5 = function(san, suffix, nag, comment, variations) {
        return node(san, suffix, nag, comment, variations);
      };
      var peg$f6 = function(nag) {
        return nag;
      };
      var peg$f7 = function(comment) {
        return comment.replace(/[\r\n]+/g, " ");
      };
      var peg$f8 = function(comment) {
        return comment.trim();
      };
      var peg$f9 = function(line) {
        return line;
      };
      var peg$f10 = function(result, comment) {
        return { result, comment };
      };
      var peg$currPos = options.peg$currPos | 0;
      var peg$posDetailsCache = [{ line: 1, column: 1 }];
      var peg$maxFailPos = peg$currPos;
      var peg$maxFailExpected = options.peg$maxFailExpected || [];
      var peg$silentFails = options.peg$silentFails | 0;
      var peg$result;
      if (options.startRule) {
        if (!(options.startRule in peg$startRuleFunctions)) {
          throw new Error(`Can't start parsing from rule "` + options.startRule + '".');
        }
        peg$startRuleFunction = peg$startRuleFunctions[options.startRule];
      }
      function peg$literalExpectation(text, ignoreCase) {
        return { type: "literal", text, ignoreCase };
      }
      function peg$classExpectation(parts, inverted, ignoreCase) {
        return { type: "class", parts, inverted, ignoreCase };
      }
      function peg$endExpectation() {
        return { type: "end" };
      }
      function peg$otherExpectation(description) {
        return { type: "other", description };
      }
      function peg$computePosDetails(pos) {
        var details = peg$posDetailsCache[pos];
        var p;
        if (details) {
          return details;
        } else {
          if (pos >= peg$posDetailsCache.length) {
            p = peg$posDetailsCache.length - 1;
          } else {
            p = pos;
            while (!peg$posDetailsCache[--p]) {
            }
          }
          details = peg$posDetailsCache[p];
          details = {
            line: details.line,
            column: details.column
          };
          while (p < pos) {
            if (input.charCodeAt(p) === 10) {
              details.line++;
              details.column = 1;
            } else {
              details.column++;
            }
            p++;
          }
          peg$posDetailsCache[pos] = details;
          return details;
        }
      }
      function peg$computeLocation(startPos, endPos, offset) {
        var startPosDetails = peg$computePosDetails(startPos);
        var endPosDetails = peg$computePosDetails(endPos);
        var res = {
          source: peg$source,
          start: {
            offset: startPos,
            line: startPosDetails.line,
            column: startPosDetails.column
          },
          end: {
            offset: endPos,
            line: endPosDetails.line,
            column: endPosDetails.column
          }
        };
        return res;
      }
      function peg$fail(expected) {
        if (peg$currPos < peg$maxFailPos) {
          return;
        }
        if (peg$currPos > peg$maxFailPos) {
          peg$maxFailPos = peg$currPos;
          peg$maxFailExpected = [];
        }
        peg$maxFailExpected.push(expected);
      }
      function peg$buildStructuredError(expected, found, location) {
        return new peg$SyntaxError(
          peg$SyntaxError.buildMessage(expected, found),
          expected,
          found,
          location
        );
      }
      function peg$parsepgn() {
        var s0, s1, s2;
        s0 = peg$currPos;
        s1 = peg$parsetagPairSection();
        s2 = peg$parsemoveTextSection();
        s0 = peg$f0(s1, s2);
        return s0;
      }
      function peg$parsetagPairSection() {
        var s0, s1, s2;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parsetagPair();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parsetagPair();
        }
        s2 = peg$parse_();
        s0 = peg$f1(s1);
        return s0;
      }
      function peg$parsetagPair() {
        var s0, s2, s4, s6, s7, s8, s10;
        peg$silentFails++;
        s0 = peg$currPos;
        peg$parse_();
        if (input.charCodeAt(peg$currPos) === 91) {
          s2 = peg$c0;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e1);
          }
        }
        if (s2 !== peg$FAILED) {
          peg$parse_();
          s4 = peg$parsetagName();
          if (s4 !== peg$FAILED) {
            peg$parse_();
            if (input.charCodeAt(peg$currPos) === 34) {
              s6 = peg$c1;
              peg$currPos++;
            } else {
              s6 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e2);
              }
            }
            if (s6 !== peg$FAILED) {
              s7 = peg$parsetagValue();
              if (input.charCodeAt(peg$currPos) === 34) {
                s8 = peg$c1;
                peg$currPos++;
              } else {
                s8 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e2);
                }
              }
              if (s8 !== peg$FAILED) {
                peg$parse_();
                if (input.charCodeAt(peg$currPos) === 93) {
                  s10 = peg$c2;
                  peg$currPos++;
                } else {
                  s10 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e3);
                  }
                }
                if (s10 !== peg$FAILED) {
                  s0 = peg$f2(s4, s7);
                } else {
                  peg$currPos = s0;
                  s0 = peg$FAILED;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          if (peg$silentFails === 0) {
            peg$fail(peg$e0);
          }
        }
        return s0;
      }
      function peg$parsetagName() {
        var s0, s1, s2;
        peg$silentFails++;
        s0 = peg$currPos;
        s1 = [];
        s2 = input.charAt(peg$currPos);
        if (peg$r0.test(s2)) {
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e5);
          }
        }
        if (s2 !== peg$FAILED) {
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = input.charAt(peg$currPos);
            if (peg$r0.test(s2)) {
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e5);
              }
            }
          }
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e4);
          }
        }
        return s0;
      }
      function peg$parsetagValue() {
        var s0, s1, s2;
        peg$silentFails++;
        s0 = peg$currPos;
        s1 = [];
        s2 = input.charAt(peg$currPos);
        if (peg$r1.test(s2)) {
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e7);
          }
        }
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = input.charAt(peg$currPos);
          if (peg$r1.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e7);
            }
          }
        }
        s0 = input.substring(s0, peg$currPos);
        peg$silentFails--;
        s1 = peg$FAILED;
        if (peg$silentFails === 0) {
          peg$fail(peg$e6);
        }
        return s0;
      }
      function peg$parsemoveTextSection() {
        var s0, s1, s3;
        s0 = peg$currPos;
        s1 = peg$parseline();
        peg$parse_();
        s3 = peg$parsegameTerminationMarker();
        if (s3 === peg$FAILED) {
          s3 = null;
        }
        peg$parse_();
        s0 = peg$f3(s1, s3);
        return s0;
      }
      function peg$parseline() {
        var s0, s1, s2, s3;
        s0 = peg$currPos;
        s1 = peg$parsecomment();
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        s2 = [];
        s3 = peg$parsemove();
        while (s3 !== peg$FAILED) {
          s2.push(s3);
          s3 = peg$parsemove();
        }
        s0 = peg$f4(s1, s2);
        return s0;
      }
      function peg$parsemove() {
        var s0, s4, s5, s6, s7, s8, s9, s10;
        s0 = peg$currPos;
        peg$parse_();
        peg$parsemoveNumber();
        peg$parse_();
        s4 = peg$parsesan();
        if (s4 !== peg$FAILED) {
          s5 = peg$parsesuffixAnnotation();
          if (s5 === peg$FAILED) {
            s5 = null;
          }
          s6 = [];
          s7 = peg$parsenag();
          while (s7 !== peg$FAILED) {
            s6.push(s7);
            s7 = peg$parsenag();
          }
          s7 = peg$parse_();
          s8 = peg$parsecomment();
          if (s8 === peg$FAILED) {
            s8 = null;
          }
          s9 = [];
          s10 = peg$parsevariation();
          while (s10 !== peg$FAILED) {
            s9.push(s10);
            s10 = peg$parsevariation();
          }
          s0 = peg$f5(s4, s5, s6, s8, s9);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsemoveNumber() {
        var s0, s1, s2, s3, s4, s5;
        peg$silentFails++;
        s0 = peg$currPos;
        s1 = [];
        s2 = input.charAt(peg$currPos);
        if (peg$r2.test(s2)) {
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e9);
          }
        }
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = input.charAt(peg$currPos);
          if (peg$r2.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e9);
            }
          }
        }
        if (input.charCodeAt(peg$currPos) === 46) {
          s2 = peg$c3;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e10);
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = peg$parse_();
          s4 = [];
          s5 = input.charAt(peg$currPos);
          if (peg$r3.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e11);
            }
          }
          while (s5 !== peg$FAILED) {
            s4.push(s5);
            s5 = input.charAt(peg$currPos);
            if (peg$r3.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e11);
              }
            }
          }
          s1 = [s1, s2, s3, s4];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e8);
          }
        }
        return s0;
      }
      function peg$parsesan() {
        var s0, s1, s2, s3, s4, s5;
        peg$silentFails++;
        s0 = peg$currPos;
        s1 = peg$currPos;
        if (input.substr(peg$currPos, 5) === peg$c4) {
          s2 = peg$c4;
          peg$currPos += 5;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e13);
          }
        }
        if (s2 === peg$FAILED) {
          if (input.substr(peg$currPos, 3) === peg$c5) {
            s2 = peg$c5;
            peg$currPos += 3;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e14);
            }
          }
          if (s2 === peg$FAILED) {
            if (input.substr(peg$currPos, 5) === peg$c6) {
              s2 = peg$c6;
              peg$currPos += 5;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e15);
              }
            }
            if (s2 === peg$FAILED) {
              if (input.substr(peg$currPos, 3) === peg$c7) {
                s2 = peg$c7;
                peg$currPos += 3;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e16);
                }
              }
              if (s2 === peg$FAILED) {
                s2 = peg$currPos;
                s3 = input.charAt(peg$currPos);
                if (peg$r0.test(s3)) {
                  peg$currPos++;
                } else {
                  s3 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e5);
                  }
                }
                if (s3 !== peg$FAILED) {
                  s4 = [];
                  s5 = input.charAt(peg$currPos);
                  if (peg$r4.test(s5)) {
                    peg$currPos++;
                  } else {
                    s5 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$e17);
                    }
                  }
                  if (s5 !== peg$FAILED) {
                    while (s5 !== peg$FAILED) {
                      s4.push(s5);
                      s5 = input.charAt(peg$currPos);
                      if (peg$r4.test(s5)) {
                        peg$currPos++;
                      } else {
                        s5 = peg$FAILED;
                        if (peg$silentFails === 0) {
                          peg$fail(peg$e17);
                        }
                      }
                    }
                  } else {
                    s4 = peg$FAILED;
                  }
                  if (s4 !== peg$FAILED) {
                    s3 = [s3, s4];
                    s2 = s3;
                  } else {
                    peg$currPos = s2;
                    s2 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$FAILED;
                }
              }
            }
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = input.charAt(peg$currPos);
          if (peg$r5.test(s3)) {
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e18);
            }
          }
          if (s3 === peg$FAILED) {
            s3 = null;
          }
          s2 = [s2, s3];
          s1 = s2;
        } else {
          peg$currPos = s1;
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e12);
          }
        }
        return s0;
      }
      function peg$parsesuffixAnnotation() {
        var s0, s1, s2;
        peg$silentFails++;
        s0 = peg$currPos;
        s1 = [];
        s2 = input.charAt(peg$currPos);
        if (peg$r6.test(s2)) {
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e20);
          }
        }
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          if (s1.length >= 2) {
            s2 = peg$FAILED;
          } else {
            s2 = input.charAt(peg$currPos);
            if (peg$r6.test(s2)) {
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e20);
              }
            }
          }
        }
        if (s1.length < 1) {
          peg$currPos = s0;
          s0 = peg$FAILED;
        } else {
          s0 = s1;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e19);
          }
        }
        return s0;
      }
      function peg$parsenag() {
        var s0, s2, s3, s4, s5;
        peg$silentFails++;
        s0 = peg$currPos;
        peg$parse_();
        if (input.charCodeAt(peg$currPos) === 36) {
          s2 = peg$c8;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e22);
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = peg$currPos;
          s4 = [];
          s5 = input.charAt(peg$currPos);
          if (peg$r2.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e9);
            }
          }
          if (s5 !== peg$FAILED) {
            while (s5 !== peg$FAILED) {
              s4.push(s5);
              s5 = input.charAt(peg$currPos);
              if (peg$r2.test(s5)) {
                peg$currPos++;
              } else {
                s5 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e9);
                }
              }
            }
          } else {
            s4 = peg$FAILED;
          }
          if (s4 !== peg$FAILED) {
            s3 = input.substring(s3, peg$currPos);
          } else {
            s3 = s4;
          }
          if (s3 !== peg$FAILED) {
            s0 = peg$f6(s3);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          if (peg$silentFails === 0) {
            peg$fail(peg$e21);
          }
        }
        return s0;
      }
      function peg$parsecomment() {
        var s0;
        s0 = peg$parsebraceComment();
        if (s0 === peg$FAILED) {
          s0 = peg$parserestOfLineComment();
        }
        return s0;
      }
      function peg$parsebraceComment() {
        var s0, s1, s2, s3, s4;
        peg$silentFails++;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 123) {
          s1 = peg$c9;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e24);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          s3 = [];
          s4 = input.charAt(peg$currPos);
          if (peg$r7.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e25);
            }
          }
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = input.charAt(peg$currPos);
            if (peg$r7.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e25);
              }
            }
          }
          s2 = input.substring(s2, peg$currPos);
          if (input.charCodeAt(peg$currPos) === 125) {
            s3 = peg$c10;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e26);
            }
          }
          if (s3 !== peg$FAILED) {
            s0 = peg$f7(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e23);
          }
        }
        return s0;
      }
      function peg$parserestOfLineComment() {
        var s0, s1, s2, s3, s4;
        peg$silentFails++;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 59) {
          s1 = peg$c11;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e28);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          s3 = [];
          s4 = input.charAt(peg$currPos);
          if (peg$r8.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = input.charAt(peg$currPos);
            if (peg$r8.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
          }
          s2 = input.substring(s2, peg$currPos);
          s0 = peg$f8(s2);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e27);
          }
        }
        return s0;
      }
      function peg$parsevariation() {
        var s0, s2, s3, s5;
        peg$silentFails++;
        s0 = peg$currPos;
        peg$parse_();
        if (input.charCodeAt(peg$currPos) === 40) {
          s2 = peg$c12;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e31);
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = peg$parseline();
          if (s3 !== peg$FAILED) {
            peg$parse_();
            if (input.charCodeAt(peg$currPos) === 41) {
              s5 = peg$c13;
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e32);
              }
            }
            if (s5 !== peg$FAILED) {
              s0 = peg$f9(s3);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          if (peg$silentFails === 0) {
            peg$fail(peg$e30);
          }
        }
        return s0;
      }
      function peg$parsegameTerminationMarker() {
        var s0, s1, s3;
        peg$silentFails++;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 3) === peg$c14) {
          s1 = peg$c14;
          peg$currPos += 3;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e34);
          }
        }
        if (s1 === peg$FAILED) {
          if (input.substr(peg$currPos, 3) === peg$c15) {
            s1 = peg$c15;
            peg$currPos += 3;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e35);
            }
          }
          if (s1 === peg$FAILED) {
            if (input.substr(peg$currPos, 7) === peg$c16) {
              s1 = peg$c16;
              peg$currPos += 7;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e36);
              }
            }
            if (s1 === peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 42) {
                s1 = peg$c17;
                peg$currPos++;
              } else {
                s1 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e37);
                }
              }
            }
          }
        }
        if (s1 !== peg$FAILED) {
          peg$parse_();
          s3 = peg$parsecomment();
          if (s3 === peg$FAILED) {
            s3 = null;
          }
          s0 = peg$f10(s1, s3);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        peg$silentFails--;
        if (s0 === peg$FAILED) {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e33);
          }
        }
        return s0;
      }
      function peg$parse_() {
        var s0, s1;
        peg$silentFails++;
        s0 = [];
        s1 = input.charAt(peg$currPos);
        if (peg$r9.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e39);
          }
        }
        while (s1 !== peg$FAILED) {
          s0.push(s1);
          s1 = input.charAt(peg$currPos);
          if (peg$r9.test(s1)) {
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e39);
            }
          }
        }
        peg$silentFails--;
        s1 = peg$FAILED;
        if (peg$silentFails === 0) {
          peg$fail(peg$e38);
        }
        return s0;
      }
      peg$result = peg$startRuleFunction();
      if (options.peg$library) {
        return (
          /** @type {any} */
          {
            peg$result,
            peg$currPos,
            peg$FAILED,
            peg$maxFailExpected,
            peg$maxFailPos
          }
        );
      }
      if (peg$result !== peg$FAILED && peg$currPos === input.length) {
        return peg$result;
      } else {
        if (peg$result !== peg$FAILED && peg$currPos < input.length) {
          peg$fail(peg$endExpectation());
        }
        throw peg$buildStructuredError(
          peg$maxFailExpected,
          peg$maxFailPos < input.length ? input.charAt(peg$maxFailPos) : null,
          peg$maxFailPos < input.length ? peg$computeLocation(peg$maxFailPos, peg$maxFailPos + 1) : peg$computeLocation(peg$maxFailPos, peg$maxFailPos)
        );
      }
    }
    var MASK64 = 0xffffffffffffffffn;
    function rotl(x, k) {
      return (x << k | x >> 64n - k) & 0xffffffffffffffffn;
    }
    function wrappingMul(x, y) {
      return x * y & MASK64;
    }
    function xoroshiro128(state) {
      return function() {
        let s0 = BigInt(state & MASK64);
        let s1 = BigInt(state >> 64n & MASK64);
        const result = wrappingMul(rotl(wrappingMul(s0, 5n), 7n), 9n);
        s1 ^= s0;
        s0 = (rotl(s0, 24n) ^ s1 ^ s1 << 16n) & MASK64;
        s1 = rotl(s1, 37n);
        state = s1 << 64n | s0;
        return result;
      };
    }
    var rand = xoroshiro128(0xa187eb39cdcaed8f31c4b365b102e01en);
    var PIECE_KEYS = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => Array.from({ length: 128 }, () => rand())));
    var EP_KEYS = Array.from({ length: 8 }, () => rand());
    var CASTLING_KEYS = Array.from({ length: 16 }, () => rand());
    var SIDE_KEY = rand();
    var WHITE = "w";
    var BLACK = "b";
    var PAWN = "p";
    var KNIGHT = "n";
    var BISHOP = "b";
    var ROOK = "r";
    var QUEEN = "q";
    var KING = "k";
    var DEFAULT_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    var Move = class {
      color;
      from;
      to;
      piece;
      captured;
      promotion;
      /**
       * @deprecated This field is deprecated and will be removed in version 2.0.0.
       * Please use move descriptor functions instead: `isCapture`, `isPromotion`,
       * `isEnPassant`, `isKingsideCastle`, `isQueensideCastle`, `isCastle`, and
       * `isBigPawn`
       */
      flags;
      san;
      lan;
      before;
      after;
      constructor(chess, internal) {
        const { color, piece, from, to, flags, captured, promotion } = internal;
        const fromAlgebraic = algebraic(from);
        const toAlgebraic = algebraic(to);
        this.color = color;
        this.piece = piece;
        this.from = fromAlgebraic;
        this.to = toAlgebraic;
        this.san = chess["_moveToSan"](internal, chess["_moves"]({ legal: true }));
        this.lan = fromAlgebraic + toAlgebraic;
        this.before = chess.fen();
        chess["_makeMove"](internal);
        this.after = chess.fen();
        chess["_undoMove"]();
        this.flags = "";
        for (const flag in BITS) {
          if (BITS[flag] & flags) {
            this.flags += FLAGS[flag];
          }
        }
        if (captured) {
          this.captured = captured;
        }
        if (promotion) {
          this.promotion = promotion;
          this.lan += promotion;
        }
      }
      isCapture() {
        return this.flags.indexOf(FLAGS["CAPTURE"]) > -1;
      }
      isPromotion() {
        return this.flags.indexOf(FLAGS["PROMOTION"]) > -1;
      }
      isEnPassant() {
        return this.flags.indexOf(FLAGS["EP_CAPTURE"]) > -1;
      }
      isKingsideCastle() {
        return this.flags.indexOf(FLAGS["KSIDE_CASTLE"]) > -1;
      }
      isQueensideCastle() {
        return this.flags.indexOf(FLAGS["QSIDE_CASTLE"]) > -1;
      }
      isBigPawn() {
        return this.flags.indexOf(FLAGS["BIG_PAWN"]) > -1;
      }
    };
    var EMPTY = -1;
    var FLAGS = {
      NORMAL: "n",
      CAPTURE: "c",
      BIG_PAWN: "b",
      EP_CAPTURE: "e",
      PROMOTION: "p",
      KSIDE_CASTLE: "k",
      QSIDE_CASTLE: "q",
      NULL_MOVE: "-"
    };
    var SQUARES = [
      "a8",
      "b8",
      "c8",
      "d8",
      "e8",
      "f8",
      "g8",
      "h8",
      "a7",
      "b7",
      "c7",
      "d7",
      "e7",
      "f7",
      "g7",
      "h7",
      "a6",
      "b6",
      "c6",
      "d6",
      "e6",
      "f6",
      "g6",
      "h6",
      "a5",
      "b5",
      "c5",
      "d5",
      "e5",
      "f5",
      "g5",
      "h5",
      "a4",
      "b4",
      "c4",
      "d4",
      "e4",
      "f4",
      "g4",
      "h4",
      "a3",
      "b3",
      "c3",
      "d3",
      "e3",
      "f3",
      "g3",
      "h3",
      "a2",
      "b2",
      "c2",
      "d2",
      "e2",
      "f2",
      "g2",
      "h2",
      "a1",
      "b1",
      "c1",
      "d1",
      "e1",
      "f1",
      "g1",
      "h1"
    ];
    var BITS = {
      NORMAL: 1,
      CAPTURE: 2,
      BIG_PAWN: 4,
      EP_CAPTURE: 8,
      PROMOTION: 16,
      KSIDE_CASTLE: 32,
      QSIDE_CASTLE: 64,
      NULL_MOVE: 128
    };
    var SEVEN_TAG_ROSTER = {
      Event: "?",
      Site: "?",
      Date: "????.??.??",
      Round: "?",
      White: "?",
      Black: "?",
      Result: "*"
    };
    var SUPLEMENTAL_TAGS = {
      WhiteTitle: null,
      BlackTitle: null,
      WhiteElo: null,
      BlackElo: null,
      WhiteUSCF: null,
      BlackUSCF: null,
      WhiteNA: null,
      BlackNA: null,
      WhiteType: null,
      BlackType: null,
      EventDate: null,
      EventSponsor: null,
      Section: null,
      Stage: null,
      Board: null,
      Opening: null,
      Variation: null,
      SubVariation: null,
      ECO: null,
      NIC: null,
      Time: null,
      UTCTime: null,
      UTCDate: null,
      TimeControl: null,
      SetUp: null,
      FEN: null,
      Termination: null,
      Annotator: null,
      Mode: null,
      PlyCount: null
    };
    var HEADER_TEMPLATE = {
      ...SEVEN_TAG_ROSTER,
      ...SUPLEMENTAL_TAGS
    };
    var Ox88 = {
      a8: 0,
      b8: 1,
      c8: 2,
      d8: 3,
      e8: 4,
      f8: 5,
      g8: 6,
      h8: 7,
      a7: 16,
      b7: 17,
      c7: 18,
      d7: 19,
      e7: 20,
      f7: 21,
      g7: 22,
      h7: 23,
      a6: 32,
      b6: 33,
      c6: 34,
      d6: 35,
      e6: 36,
      f6: 37,
      g6: 38,
      h6: 39,
      a5: 48,
      b5: 49,
      c5: 50,
      d5: 51,
      e5: 52,
      f5: 53,
      g5: 54,
      h5: 55,
      a4: 64,
      b4: 65,
      c4: 66,
      d4: 67,
      e4: 68,
      f4: 69,
      g4: 70,
      h4: 71,
      a3: 80,
      b3: 81,
      c3: 82,
      d3: 83,
      e3: 84,
      f3: 85,
      g3: 86,
      h3: 87,
      a2: 96,
      b2: 97,
      c2: 98,
      d2: 99,
      e2: 100,
      f2: 101,
      g2: 102,
      h2: 103,
      a1: 112,
      b1: 113,
      c1: 114,
      d1: 115,
      e1: 116,
      f1: 117,
      g1: 118,
      h1: 119
    };
    var PAWN_OFFSETS = {
      b: [16, 32, 17, 15],
      w: [-16, -32, -17, -15]
    };
    var PIECE_OFFSETS = {
      n: [-18, -33, -31, -14, 18, 33, 31, 14],
      b: [-17, -15, 17, 15],
      r: [-16, 1, 16, -1],
      q: [-17, -16, -15, 1, 17, 16, 15, -1],
      k: [-17, -16, -15, 1, 17, 16, 15, -1]
    };
    var ATTACKS = [
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      24,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      2,
      24,
      2,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      2,
      53,
      56,
      53,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      24,
      24,
      24,
      24,
      24,
      24,
      56,
      0,
      56,
      24,
      24,
      24,
      24,
      24,
      24,
      0,
      0,
      0,
      0,
      0,
      0,
      2,
      53,
      56,
      53,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      2,
      24,
      2,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      24,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      0,
      20,
      0,
      0,
      0,
      0,
      0,
      0,
      24,
      0,
      0,
      0,
      0,
      0,
      0,
      20
    ];
    var RAYS = [
      17,
      0,
      0,
      0,
      0,
      0,
      0,
      16,
      0,
      0,
      0,
      0,
      0,
      0,
      15,
      0,
      0,
      17,
      0,
      0,
      0,
      0,
      0,
      16,
      0,
      0,
      0,
      0,
      0,
      15,
      0,
      0,
      0,
      0,
      17,
      0,
      0,
      0,
      0,
      16,
      0,
      0,
      0,
      0,
      15,
      0,
      0,
      0,
      0,
      0,
      0,
      17,
      0,
      0,
      0,
      16,
      0,
      0,
      0,
      15,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      17,
      0,
      0,
      16,
      0,
      0,
      15,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      17,
      0,
      16,
      0,
      15,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      17,
      16,
      15,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      -15,
      -16,
      -17,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      -15,
      0,
      -16,
      0,
      -17,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      -15,
      0,
      0,
      -16,
      0,
      0,
      -17,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      -15,
      0,
      0,
      0,
      -16,
      0,
      0,
      0,
      -17,
      0,
      0,
      0,
      0,
      0,
      0,
      -15,
      0,
      0,
      0,
      0,
      -16,
      0,
      0,
      0,
      0,
      -17,
      0,
      0,
      0,
      0,
      -15,
      0,
      0,
      0,
      0,
      0,
      -16,
      0,
      0,
      0,
      0,
      0,
      -17,
      0,
      0,
      -15,
      0,
      0,
      0,
      0,
      0,
      0,
      -16,
      0,
      0,
      0,
      0,
      0,
      0,
      -17
    ];
    var PIECE_MASKS = { p: 1, n: 2, b: 4, r: 8, q: 16, k: 32 };
    var SYMBOLS = "pnbrqkPNBRQK";
    var PROMOTIONS = [KNIGHT, BISHOP, ROOK, QUEEN];
    var RANK_1 = 7;
    var RANK_2 = 6;
    var RANK_7 = 1;
    var RANK_8 = 0;
    var SIDES = {
      [KING]: BITS.KSIDE_CASTLE,
      [QUEEN]: BITS.QSIDE_CASTLE
    };
    var ROOKS = {
      w: [
        { square: Ox88.a1, flag: BITS.QSIDE_CASTLE },
        { square: Ox88.h1, flag: BITS.KSIDE_CASTLE }
      ],
      b: [
        { square: Ox88.a8, flag: BITS.QSIDE_CASTLE },
        { square: Ox88.h8, flag: BITS.KSIDE_CASTLE }
      ]
    };
    var SECOND_RANK = { b: RANK_7, w: RANK_2 };
    var SAN_NULLMOVE = "--";
    function rank(square) {
      return square >> 4;
    }
    function file(square) {
      return square & 15;
    }
    function isDigit(c) {
      return "0123456789".indexOf(c) !== -1;
    }
    function algebraic(square) {
      const f = file(square);
      const r = rank(square);
      return "abcdefgh".substring(f, f + 1) + "87654321".substring(r, r + 1);
    }
    function swapColor(color) {
      return color === WHITE ? BLACK : WHITE;
    }
    function validateFen(fen) {
      const tokens = fen.split(/\s+/);
      if (tokens.length !== 6) {
        return {
          ok: false,
          error: "Invalid FEN: must contain six space-delimited fields"
        };
      }
      const moveNumber = parseInt(tokens[5], 10);
      if (isNaN(moveNumber) || moveNumber <= 0) {
        return {
          ok: false,
          error: "Invalid FEN: move number must be a positive integer"
        };
      }
      const halfMoves = parseInt(tokens[4], 10);
      if (isNaN(halfMoves) || halfMoves < 0) {
        return {
          ok: false,
          error: "Invalid FEN: half move counter number must be a non-negative integer"
        };
      }
      if (!/^(-|[abcdefgh][36])$/.test(tokens[3])) {
        return { ok: false, error: "Invalid FEN: en-passant square is invalid" };
      }
      if (/[^kKqQ-]/.test(tokens[2])) {
        return { ok: false, error: "Invalid FEN: castling availability is invalid" };
      }
      if (!/^(w|b)$/.test(tokens[1])) {
        return { ok: false, error: "Invalid FEN: side-to-move is invalid" };
      }
      const rows = tokens[0].split("/");
      if (rows.length !== 8) {
        return {
          ok: false,
          error: "Invalid FEN: piece data does not contain 8 '/'-delimited rows"
        };
      }
      for (let i = 0; i < rows.length; i++) {
        let sumFields = 0;
        let previousWasNumber = false;
        for (let k = 0; k < rows[i].length; k++) {
          if (isDigit(rows[i][k])) {
            if (previousWasNumber) {
              return {
                ok: false,
                error: "Invalid FEN: piece data is invalid (consecutive number)"
              };
            }
            sumFields += parseInt(rows[i][k], 10);
            previousWasNumber = true;
          } else {
            if (!/^[prnbqkPRNBQK]$/.test(rows[i][k])) {
              return {
                ok: false,
                error: "Invalid FEN: piece data is invalid (invalid piece)"
              };
            }
            sumFields += 1;
            previousWasNumber = false;
          }
        }
        if (sumFields !== 8) {
          return {
            ok: false,
            error: "Invalid FEN: piece data is invalid (too many squares in rank)"
          };
        }
      }
      if (tokens[3][1] == "3" && tokens[1] == "w" || tokens[3][1] == "6" && tokens[1] == "b") {
        return { ok: false, error: "Invalid FEN: illegal en-passant square" };
      }
      const kings = [
        { color: "white", regex: /K/g },
        { color: "black", regex: /k/g }
      ];
      for (const { color, regex } of kings) {
        if (!regex.test(tokens[0])) {
          return { ok: false, error: `Invalid FEN: missing ${color} king` };
        }
        if ((tokens[0].match(regex) || []).length > 1) {
          return { ok: false, error: `Invalid FEN: too many ${color} kings` };
        }
      }
      if (Array.from(rows[0] + rows[7]).some((char) => char.toUpperCase() === "P")) {
        return {
          ok: false,
          error: "Invalid FEN: some pawns are on the edge rows"
        };
      }
      return { ok: true };
    }
    function getDisambiguator(move, moves) {
      const from = move.from;
      const to = move.to;
      const piece = move.piece;
      let ambiguities = 0;
      let sameRank = 0;
      let sameFile = 0;
      for (let i = 0, len = moves.length; i < len; i++) {
        const ambigFrom = moves[i].from;
        const ambigTo = moves[i].to;
        const ambigPiece = moves[i].piece;
        if (piece === ambigPiece && from !== ambigFrom && to === ambigTo) {
          ambiguities++;
          if (rank(from) === rank(ambigFrom)) {
            sameRank++;
          }
          if (file(from) === file(ambigFrom)) {
            sameFile++;
          }
        }
      }
      if (ambiguities > 0) {
        if (sameRank > 0 && sameFile > 0) {
          return algebraic(from);
        } else if (sameFile > 0) {
          return algebraic(from).charAt(1);
        } else {
          return algebraic(from).charAt(0);
        }
      }
      return "";
    }
    function addMove(moves, color, from, to, piece, captured = void 0, flags = BITS.NORMAL) {
      const r = rank(to);
      if (piece === PAWN && (r === RANK_1 || r === RANK_8)) {
        for (let i = 0; i < PROMOTIONS.length; i++) {
          const promotion = PROMOTIONS[i];
          moves.push({
            color,
            from,
            to,
            piece,
            captured,
            promotion,
            flags: flags | BITS.PROMOTION
          });
        }
      } else {
        moves.push({
          color,
          from,
          to,
          piece,
          captured,
          flags
        });
      }
    }
    function inferPieceType(san) {
      let pieceType = san.charAt(0);
      if (pieceType >= "a" && pieceType <= "h") {
        const matches = san.match(/[a-h]\d.*[a-h]\d/);
        if (matches) {
          return void 0;
        }
        return PAWN;
      }
      pieceType = pieceType.toLowerCase();
      if (pieceType === "o") {
        return KING;
      }
      return pieceType;
    }
    function strippedSan(move) {
      return move.replace(/=/, "").replace(/[+#]?[?!]*$/, "");
    }
    var Chess = class {
      _board = new Array(128);
      _turn = WHITE;
      _header = {};
      _kings = { w: EMPTY, b: EMPTY };
      _epSquare = -1;
      _halfMoves = 0;
      _moveNumber = 0;
      _history = [];
      _comments = {};
      _castling = { w: 0, b: 0 };
      _hash = 0n;
      // tracks number of times a position has been seen for repetition checking
      _positionCount = /* @__PURE__ */ new Map();
      constructor(fen = DEFAULT_POSITION, { skipValidation = false } = {}) {
        this.load(fen, { skipValidation });
      }
      clear({ preserveHeaders = false } = {}) {
        this._board = new Array(128);
        this._kings = { w: EMPTY, b: EMPTY };
        this._turn = WHITE;
        this._castling = { w: 0, b: 0 };
        this._epSquare = EMPTY;
        this._halfMoves = 0;
        this._moveNumber = 1;
        this._history = [];
        this._comments = {};
        this._header = preserveHeaders ? this._header : { ...HEADER_TEMPLATE };
        this._hash = this._computeHash();
        this._positionCount = /* @__PURE__ */ new Map();
        this._header["SetUp"] = null;
        this._header["FEN"] = null;
      }
      load(fen, { skipValidation = false, preserveHeaders = false } = {}) {
        let tokens = fen.split(/\s+/);
        if (tokens.length >= 2 && tokens.length < 6) {
          const adjustments = ["-", "-", "0", "1"];
          fen = tokens.concat(adjustments.slice(-(6 - tokens.length))).join(" ");
        }
        tokens = fen.split(/\s+/);
        if (!skipValidation) {
          const { ok, error } = validateFen(fen);
          if (!ok) {
            throw new Error(error);
          }
        }
        const position = tokens[0];
        let square = 0;
        this.clear({ preserveHeaders });
        for (let i = 0; i < position.length; i++) {
          const piece = position.charAt(i);
          if (piece === "/") {
            square += 8;
          } else if (isDigit(piece)) {
            square += parseInt(piece, 10);
          } else {
            const color = piece < "a" ? WHITE : BLACK;
            this._put({ type: piece.toLowerCase(), color }, algebraic(square));
            square++;
          }
        }
        this._turn = tokens[1];
        if (tokens[2].indexOf("K") > -1) {
          this._castling.w |= BITS.KSIDE_CASTLE;
        }
        if (tokens[2].indexOf("Q") > -1) {
          this._castling.w |= BITS.QSIDE_CASTLE;
        }
        if (tokens[2].indexOf("k") > -1) {
          this._castling.b |= BITS.KSIDE_CASTLE;
        }
        if (tokens[2].indexOf("q") > -1) {
          this._castling.b |= BITS.QSIDE_CASTLE;
        }
        this._epSquare = tokens[3] === "-" ? EMPTY : Ox88[tokens[3]];
        this._halfMoves = parseInt(tokens[4], 10);
        this._moveNumber = parseInt(tokens[5], 10);
        this._hash = this._computeHash();
        this._updateSetup(fen);
        this._incPositionCount();
      }
      fen({ forceEnpassantSquare = false } = {}) {
        let empty = 0;
        let fen = "";
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (this._board[i]) {
            if (empty > 0) {
              fen += empty;
              empty = 0;
            }
            const { color, type: piece } = this._board[i];
            fen += color === WHITE ? piece.toUpperCase() : piece.toLowerCase();
          } else {
            empty++;
          }
          if (i + 1 & 136) {
            if (empty > 0) {
              fen += empty;
            }
            if (i !== Ox88.h1) {
              fen += "/";
            }
            empty = 0;
            i += 8;
          }
        }
        let castling = "";
        if (this._castling[WHITE] & BITS.KSIDE_CASTLE) {
          castling += "K";
        }
        if (this._castling[WHITE] & BITS.QSIDE_CASTLE) {
          castling += "Q";
        }
        if (this._castling[BLACK] & BITS.KSIDE_CASTLE) {
          castling += "k";
        }
        if (this._castling[BLACK] & BITS.QSIDE_CASTLE) {
          castling += "q";
        }
        castling = castling || "-";
        let epSquare = "-";
        if (this._epSquare !== EMPTY) {
          if (forceEnpassantSquare) {
            epSquare = algebraic(this._epSquare);
          } else {
            const bigPawnSquare = this._epSquare + (this._turn === WHITE ? 16 : -16);
            const squares = [bigPawnSquare + 1, bigPawnSquare - 1];
            for (const square of squares) {
              if (square & 136) {
                continue;
              }
              const color = this._turn;
              if (this._board[square]?.color === color && this._board[square]?.type === PAWN) {
                this._makeMove({
                  color,
                  from: square,
                  to: this._epSquare,
                  piece: PAWN,
                  captured: PAWN,
                  flags: BITS.EP_CAPTURE
                });
                const isLegal = !this._isKingAttacked(color);
                this._undoMove();
                if (isLegal) {
                  epSquare = algebraic(this._epSquare);
                  break;
                }
              }
            }
          }
        }
        return [
          fen,
          this._turn,
          castling,
          epSquare,
          this._halfMoves,
          this._moveNumber
        ].join(" ");
      }
      _pieceKey(i) {
        if (!this._board[i]) {
          return 0n;
        }
        const { color, type } = this._board[i];
        const colorIndex = {
          w: 0,
          b: 1
        }[color];
        const typeIndex = {
          p: 0,
          n: 1,
          b: 2,
          r: 3,
          q: 4,
          k: 5
        }[type];
        return PIECE_KEYS[colorIndex][typeIndex][i];
      }
      _epKey() {
        return this._epSquare === EMPTY ? 0n : EP_KEYS[this._epSquare & 7];
      }
      _castlingKey() {
        const index = this._castling.w >> 5 | this._castling.b >> 3;
        return CASTLING_KEYS[index];
      }
      _computeHash() {
        let hash = 0n;
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (i & 136) {
            i += 7;
            continue;
          }
          if (this._board[i]) {
            hash ^= this._pieceKey(i);
          }
        }
        hash ^= this._epKey();
        hash ^= this._castlingKey();
        if (this._turn === "b") {
          hash ^= SIDE_KEY;
        }
        return hash;
      }
      /*
       * Called when the initial board setup is changed with put() or remove().
       * modifies the SetUp and FEN properties of the header object. If the FEN
       * is equal to the default position, the SetUp and FEN are deleted the setup
       * is only updated if history.length is zero, ie moves haven't been made.
       */
      _updateSetup(fen) {
        if (this._history.length > 0)
          return;
        if (fen !== DEFAULT_POSITION) {
          this._header["SetUp"] = "1";
          this._header["FEN"] = fen;
        } else {
          this._header["SetUp"] = null;
          this._header["FEN"] = null;
        }
      }
      reset() {
        this.load(DEFAULT_POSITION);
      }
      get(square) {
        return this._board[Ox88[square]];
      }
      findPiece(piece) {
        const squares = [];
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (i & 136) {
            i += 7;
            continue;
          }
          if (!this._board[i] || this._board[i]?.color !== piece.color) {
            continue;
          }
          if (this._board[i].color === piece.color && this._board[i].type === piece.type) {
            squares.push(algebraic(i));
          }
        }
        return squares;
      }
      put({ type, color }, square) {
        if (this._put({ type, color }, square)) {
          this._updateCastlingRights();
          this._updateEnPassantSquare();
          this._updateSetup(this.fen());
          return true;
        }
        return false;
      }
      _set(sq, piece) {
        this._hash ^= this._pieceKey(sq);
        this._board[sq] = piece;
        this._hash ^= this._pieceKey(sq);
      }
      _put({ type, color }, square) {
        if (SYMBOLS.indexOf(type.toLowerCase()) === -1) {
          return false;
        }
        if (!(square in Ox88)) {
          return false;
        }
        const sq = Ox88[square];
        if (type == KING && !(this._kings[color] == EMPTY || this._kings[color] == sq)) {
          return false;
        }
        const currentPieceOnSquare = this._board[sq];
        if (currentPieceOnSquare && currentPieceOnSquare.type === KING) {
          this._kings[currentPieceOnSquare.color] = EMPTY;
        }
        this._set(sq, { type, color });
        if (type === KING) {
          this._kings[color] = sq;
        }
        return true;
      }
      _clear(sq) {
        this._hash ^= this._pieceKey(sq);
        delete this._board[sq];
      }
      remove(square) {
        const piece = this.get(square);
        this._clear(Ox88[square]);
        if (piece && piece.type === KING) {
          this._kings[piece.color] = EMPTY;
        }
        this._updateCastlingRights();
        this._updateEnPassantSquare();
        this._updateSetup(this.fen());
        return piece;
      }
      _updateCastlingRights() {
        this._hash ^= this._castlingKey();
        const whiteKingInPlace = this._board[Ox88.e1]?.type === KING && this._board[Ox88.e1]?.color === WHITE;
        const blackKingInPlace = this._board[Ox88.e8]?.type === KING && this._board[Ox88.e8]?.color === BLACK;
        if (!whiteKingInPlace || this._board[Ox88.a1]?.type !== ROOK || this._board[Ox88.a1]?.color !== WHITE) {
          this._castling.w &= -65;
        }
        if (!whiteKingInPlace || this._board[Ox88.h1]?.type !== ROOK || this._board[Ox88.h1]?.color !== WHITE) {
          this._castling.w &= -33;
        }
        if (!blackKingInPlace || this._board[Ox88.a8]?.type !== ROOK || this._board[Ox88.a8]?.color !== BLACK) {
          this._castling.b &= -65;
        }
        if (!blackKingInPlace || this._board[Ox88.h8]?.type !== ROOK || this._board[Ox88.h8]?.color !== BLACK) {
          this._castling.b &= -33;
        }
        this._hash ^= this._castlingKey();
      }
      _updateEnPassantSquare() {
        if (this._epSquare === EMPTY) {
          return;
        }
        const startSquare = this._epSquare + (this._turn === WHITE ? -16 : 16);
        const currentSquare = this._epSquare + (this._turn === WHITE ? 16 : -16);
        const attackers = [currentSquare + 1, currentSquare - 1];
        if (this._board[startSquare] !== null || this._board[this._epSquare] !== null || this._board[currentSquare]?.color !== swapColor(this._turn) || this._board[currentSquare]?.type !== PAWN) {
          this._hash ^= this._epKey();
          this._epSquare = EMPTY;
          return;
        }
        const canCapture = (square) => !(square & 136) && this._board[square]?.color === this._turn && this._board[square]?.type === PAWN;
        if (!attackers.some(canCapture)) {
          this._hash ^= this._epKey();
          this._epSquare = EMPTY;
        }
      }
      _attacked(color, square, verbose) {
        const attackers = [];
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (i & 136) {
            i += 7;
            continue;
          }
          if (this._board[i] === void 0 || this._board[i].color !== color) {
            continue;
          }
          const piece = this._board[i];
          const difference = i - square;
          if (difference === 0) {
            continue;
          }
          const index = difference + 119;
          if (ATTACKS[index] & PIECE_MASKS[piece.type]) {
            if (piece.type === PAWN) {
              if (difference > 0 && piece.color === WHITE || difference <= 0 && piece.color === BLACK) {
                if (!verbose) {
                  return true;
                } else {
                  attackers.push(algebraic(i));
                }
              }
              continue;
            }
            if (piece.type === "n" || piece.type === "k") {
              if (!verbose) {
                return true;
              } else {
                attackers.push(algebraic(i));
                continue;
              }
            }
            const offset = RAYS[index];
            let j = i + offset;
            let blocked = false;
            while (j !== square) {
              if (this._board[j] != null) {
                blocked = true;
                break;
              }
              j += offset;
            }
            if (!blocked) {
              if (!verbose) {
                return true;
              } else {
                attackers.push(algebraic(i));
                continue;
              }
            }
          }
        }
        if (verbose) {
          return attackers;
        } else {
          return false;
        }
      }
      attackers(square, attackedBy) {
        if (!attackedBy) {
          return this._attacked(this._turn, Ox88[square], true);
        } else {
          return this._attacked(attackedBy, Ox88[square], true);
        }
      }
      _isKingAttacked(color) {
        const square = this._kings[color];
        return square === -1 ? false : this._attacked(swapColor(color), square);
      }
      hash() {
        return this._hash.toString(16);
      }
      isAttacked(square, attackedBy) {
        return this._attacked(attackedBy, Ox88[square]);
      }
      isCheck() {
        return this._isKingAttacked(this._turn);
      }
      inCheck() {
        return this.isCheck();
      }
      isCheckmate() {
        return this.isCheck() && this._moves().length === 0;
      }
      isStalemate() {
        return !this.isCheck() && this._moves().length === 0;
      }
      isInsufficientMaterial() {
        const pieces = {
          b: 0,
          n: 0,
          r: 0,
          q: 0,
          k: 0,
          p: 0
        };
        const bishops = [];
        let numPieces = 0;
        let squareColor = 0;
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          squareColor = (squareColor + 1) % 2;
          if (i & 136) {
            i += 7;
            continue;
          }
          const piece = this._board[i];
          if (piece) {
            pieces[piece.type] = piece.type in pieces ? pieces[piece.type] + 1 : 1;
            if (piece.type === BISHOP) {
              bishops.push(squareColor);
            }
            numPieces++;
          }
        }
        if (numPieces === 2) {
          return true;
        } else if (
          // k vs. kn .... or .... k vs. kb
          numPieces === 3 && (pieces[BISHOP] === 1 || pieces[KNIGHT] === 1)
        ) {
          return true;
        } else if (numPieces === pieces[BISHOP] + 2) {
          let sum = 0;
          const len = bishops.length;
          for (let i = 0; i < len; i++) {
            sum += bishops[i];
          }
          if (sum === 0 || sum === len) {
            return true;
          }
        }
        return false;
      }
      isThreefoldRepetition() {
        return this._getPositionCount(this._hash) >= 3;
      }
      isDrawByFiftyMoves() {
        return this._halfMoves >= 100;
      }
      isDraw() {
        return this.isDrawByFiftyMoves() || this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition();
      }
      isGameOver() {
        return this.isCheckmate() || this.isDraw();
      }
      moves({ verbose = false, square = void 0, piece = void 0 } = {}) {
        const moves = this._moves({ square, piece });
        if (verbose) {
          return moves.map((move) => new Move(this, move));
        } else {
          return moves.map((move) => this._moveToSan(move, moves));
        }
      }
      _moves({ legal = true, piece = void 0, square = void 0 } = {}) {
        const forSquare = square ? square.toLowerCase() : void 0;
        const forPiece = piece?.toLowerCase();
        const moves = [];
        const us = this._turn;
        const them = swapColor(us);
        let firstSquare = Ox88.a8;
        let lastSquare = Ox88.h1;
        let singleSquare = false;
        if (forSquare) {
          if (!(forSquare in Ox88)) {
            return [];
          } else {
            firstSquare = lastSquare = Ox88[forSquare];
            singleSquare = true;
          }
        }
        for (let from = firstSquare; from <= lastSquare; from++) {
          if (from & 136) {
            from += 7;
            continue;
          }
          if (!this._board[from] || this._board[from].color === them) {
            continue;
          }
          const { type } = this._board[from];
          let to;
          if (type === PAWN) {
            if (forPiece && forPiece !== type)
              continue;
            to = from + PAWN_OFFSETS[us][0];
            if (!this._board[to]) {
              addMove(moves, us, from, to, PAWN);
              to = from + PAWN_OFFSETS[us][1];
              if (SECOND_RANK[us] === rank(from) && !this._board[to]) {
                addMove(moves, us, from, to, PAWN, void 0, BITS.BIG_PAWN);
              }
            }
            for (let j = 2; j < 4; j++) {
              to = from + PAWN_OFFSETS[us][j];
              if (to & 136)
                continue;
              if (this._board[to]?.color === them) {
                addMove(moves, us, from, to, PAWN, this._board[to].type, BITS.CAPTURE);
              } else if (to === this._epSquare) {
                addMove(moves, us, from, to, PAWN, PAWN, BITS.EP_CAPTURE);
              }
            }
          } else {
            if (forPiece && forPiece !== type)
              continue;
            for (let j = 0, len = PIECE_OFFSETS[type].length; j < len; j++) {
              const offset = PIECE_OFFSETS[type][j];
              to = from;
              while (true) {
                to += offset;
                if (to & 136)
                  break;
                if (!this._board[to]) {
                  addMove(moves, us, from, to, type);
                } else {
                  if (this._board[to].color === us)
                    break;
                  addMove(moves, us, from, to, type, this._board[to].type, BITS.CAPTURE);
                  break;
                }
                if (type === KNIGHT || type === KING)
                  break;
              }
            }
          }
        }
        if (forPiece === void 0 || forPiece === KING) {
          if (!singleSquare || lastSquare === this._kings[us]) {
            if (this._castling[us] & BITS.KSIDE_CASTLE) {
              const castlingFrom = this._kings[us];
              const castlingTo = castlingFrom + 2;
              if (!this._board[castlingFrom + 1] && !this._board[castlingTo] && !this._attacked(them, this._kings[us]) && !this._attacked(them, castlingFrom + 1) && !this._attacked(them, castlingTo)) {
                addMove(moves, us, this._kings[us], castlingTo, KING, void 0, BITS.KSIDE_CASTLE);
              }
            }
            if (this._castling[us] & BITS.QSIDE_CASTLE) {
              const castlingFrom = this._kings[us];
              const castlingTo = castlingFrom - 2;
              if (!this._board[castlingFrom - 1] && !this._board[castlingFrom - 2] && !this._board[castlingFrom - 3] && !this._attacked(them, this._kings[us]) && !this._attacked(them, castlingFrom - 1) && !this._attacked(them, castlingTo)) {
                addMove(moves, us, this._kings[us], castlingTo, KING, void 0, BITS.QSIDE_CASTLE);
              }
            }
          }
        }
        if (!legal || this._kings[us] === -1) {
          return moves;
        }
        const legalMoves = [];
        for (let i = 0, len = moves.length; i < len; i++) {
          this._makeMove(moves[i]);
          if (!this._isKingAttacked(us)) {
            legalMoves.push(moves[i]);
          }
          this._undoMove();
        }
        return legalMoves;
      }
      move(move, { strict = false } = {}) {
        let moveObj = null;
        if (typeof move === "string") {
          moveObj = this._moveFromSan(move, strict);
        } else if (move === null) {
          moveObj = this._moveFromSan(SAN_NULLMOVE, strict);
        } else if (typeof move === "object") {
          const moves = this._moves();
          for (let i = 0, len = moves.length; i < len; i++) {
            if (move.from === algebraic(moves[i].from) && move.to === algebraic(moves[i].to) && (!("promotion" in moves[i]) || move.promotion === moves[i].promotion)) {
              moveObj = moves[i];
              break;
            }
          }
        }
        if (!moveObj) {
          if (typeof move === "string") {
            throw new Error(`Invalid move: ${move}`);
          } else {
            throw new Error(`Invalid move: ${JSON.stringify(move)}`);
          }
        }
        if (this.isCheck() && moveObj.flags & BITS.NULL_MOVE) {
          throw new Error("Null move not allowed when in check");
        }
        const prettyMove = new Move(this, moveObj);
        this._makeMove(moveObj);
        this._incPositionCount();
        return prettyMove;
      }
      _push(move) {
        this._history.push({
          move,
          kings: { b: this._kings.b, w: this._kings.w },
          turn: this._turn,
          castling: { b: this._castling.b, w: this._castling.w },
          epSquare: this._epSquare,
          halfMoves: this._halfMoves,
          moveNumber: this._moveNumber
        });
      }
      _movePiece(from, to) {
        this._hash ^= this._pieceKey(from);
        this._board[to] = this._board[from];
        delete this._board[from];
        this._hash ^= this._pieceKey(to);
      }
      _makeMove(move) {
        const us = this._turn;
        const them = swapColor(us);
        this._push(move);
        if (move.flags & BITS.NULL_MOVE) {
          if (us === BLACK) {
            this._moveNumber++;
          }
          this._halfMoves++;
          this._turn = them;
          this._epSquare = EMPTY;
          return;
        }
        this._hash ^= this._epKey();
        this._hash ^= this._castlingKey();
        if (move.captured) {
          this._hash ^= this._pieceKey(move.to);
        }
        this._movePiece(move.from, move.to);
        if (move.flags & BITS.EP_CAPTURE) {
          if (this._turn === BLACK) {
            this._clear(move.to - 16);
          } else {
            this._clear(move.to + 16);
          }
        }
        if (move.promotion) {
          this._clear(move.to);
          this._set(move.to, { type: move.promotion, color: us });
        }
        if (this._board[move.to].type === KING) {
          this._kings[us] = move.to;
          if (move.flags & BITS.KSIDE_CASTLE) {
            const castlingTo = move.to - 1;
            const castlingFrom = move.to + 1;
            this._movePiece(castlingFrom, castlingTo);
          } else if (move.flags & BITS.QSIDE_CASTLE) {
            const castlingTo = move.to + 1;
            const castlingFrom = move.to - 2;
            this._movePiece(castlingFrom, castlingTo);
          }
          this._castling[us] = 0;
        }
        if (this._castling[us]) {
          for (let i = 0, len = ROOKS[us].length; i < len; i++) {
            if (move.from === ROOKS[us][i].square && this._castling[us] & ROOKS[us][i].flag) {
              this._castling[us] ^= ROOKS[us][i].flag;
              break;
            }
          }
        }
        if (this._castling[them]) {
          for (let i = 0, len = ROOKS[them].length; i < len; i++) {
            if (move.to === ROOKS[them][i].square && this._castling[them] & ROOKS[them][i].flag) {
              this._castling[them] ^= ROOKS[them][i].flag;
              break;
            }
          }
        }
        this._hash ^= this._castlingKey();
        if (move.flags & BITS.BIG_PAWN) {
          let epSquare;
          if (us === BLACK) {
            epSquare = move.to - 16;
          } else {
            epSquare = move.to + 16;
          }
          if (!(move.to - 1 & 136) && this._board[move.to - 1]?.type === PAWN && this._board[move.to - 1]?.color === them || !(move.to + 1 & 136) && this._board[move.to + 1]?.type === PAWN && this._board[move.to + 1]?.color === them) {
            this._epSquare = epSquare;
            this._hash ^= this._epKey();
          } else {
            this._epSquare = EMPTY;
          }
        } else {
          this._epSquare = EMPTY;
        }
        if (move.piece === PAWN) {
          this._halfMoves = 0;
        } else if (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) {
          this._halfMoves = 0;
        } else {
          this._halfMoves++;
        }
        if (us === BLACK) {
          this._moveNumber++;
        }
        this._turn = them;
        this._hash ^= SIDE_KEY;
      }
      undo() {
        const hash = this._hash;
        const move = this._undoMove();
        if (move) {
          const prettyMove = new Move(this, move);
          this._decPositionCount(hash);
          return prettyMove;
        }
        return null;
      }
      _undoMove() {
        const old = this._history.pop();
        if (old === void 0) {
          return null;
        }
        this._hash ^= this._epKey();
        this._hash ^= this._castlingKey();
        const move = old.move;
        this._kings = old.kings;
        this._turn = old.turn;
        this._castling = old.castling;
        this._epSquare = old.epSquare;
        this._halfMoves = old.halfMoves;
        this._moveNumber = old.moveNumber;
        this._hash ^= this._epKey();
        this._hash ^= this._castlingKey();
        this._hash ^= SIDE_KEY;
        const us = this._turn;
        const them = swapColor(us);
        if (move.flags & BITS.NULL_MOVE) {
          return move;
        }
        this._movePiece(move.to, move.from);
        if (move.piece) {
          this._clear(move.from);
          this._set(move.from, { type: move.piece, color: us });
        }
        if (move.captured) {
          if (move.flags & BITS.EP_CAPTURE) {
            let index;
            if (us === BLACK) {
              index = move.to - 16;
            } else {
              index = move.to + 16;
            }
            this._set(index, { type: PAWN, color: them });
          } else {
            this._set(move.to, { type: move.captured, color: them });
          }
        }
        if (move.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE)) {
          let castlingTo, castlingFrom;
          if (move.flags & BITS.KSIDE_CASTLE) {
            castlingTo = move.to + 1;
            castlingFrom = move.to - 1;
          } else {
            castlingTo = move.to - 2;
            castlingFrom = move.to + 1;
          }
          this._movePiece(castlingFrom, castlingTo);
        }
        return move;
      }
      pgn({ newline = "\n", maxWidth = 0 } = {}) {
        const result = [];
        let headerExists = false;
        for (const i in this._header) {
          const headerTag = this._header[i];
          if (headerTag)
            result.push(`[${i} "${this._header[i]}"]` + newline);
          headerExists = true;
        }
        if (headerExists && this._history.length) {
          result.push(newline);
        }
        const appendComment = (moveString2) => {
          const comment = this._comments[this.fen()];
          if (typeof comment !== "undefined") {
            const delimiter = moveString2.length > 0 ? " " : "";
            moveString2 = `${moveString2}${delimiter}{${comment}}`;
          }
          return moveString2;
        };
        const reversedHistory = [];
        while (this._history.length > 0) {
          reversedHistory.push(this._undoMove());
        }
        const moves = [];
        let moveString = "";
        if (reversedHistory.length === 0) {
          moves.push(appendComment(""));
        }
        while (reversedHistory.length > 0) {
          moveString = appendComment(moveString);
          const move = reversedHistory.pop();
          if (!move) {
            break;
          }
          if (!this._history.length && move.color === "b") {
            const prefix = `${this._moveNumber}. ...`;
            moveString = moveString ? `${moveString} ${prefix}` : prefix;
          } else if (move.color === "w") {
            if (moveString.length) {
              moves.push(moveString);
            }
            moveString = this._moveNumber + ".";
          }
          moveString = moveString + " " + this._moveToSan(move, this._moves({ legal: true }));
          this._makeMove(move);
        }
        if (moveString.length) {
          moves.push(appendComment(moveString));
        }
        moves.push(this._header.Result || "*");
        if (maxWidth === 0) {
          return result.join("") + moves.join(" ");
        }
        const strip = function() {
          if (result.length > 0 && result[result.length - 1] === " ") {
            result.pop();
            return true;
          }
          return false;
        };
        const wrapComment = function(width, move) {
          for (const token of move.split(" ")) {
            if (!token) {
              continue;
            }
            if (width + token.length > maxWidth) {
              while (strip()) {
                width--;
              }
              result.push(newline);
              width = 0;
            }
            result.push(token);
            width += token.length;
            result.push(" ");
            width++;
          }
          if (strip()) {
            width--;
          }
          return width;
        };
        let currentWidth = 0;
        for (let i = 0; i < moves.length; i++) {
          if (currentWidth + moves[i].length > maxWidth) {
            if (moves[i].includes("{")) {
              currentWidth = wrapComment(currentWidth, moves[i]);
              continue;
            }
          }
          if (currentWidth + moves[i].length > maxWidth && i !== 0) {
            if (result[result.length - 1] === " ") {
              result.pop();
            }
            result.push(newline);
            currentWidth = 0;
          } else if (i !== 0) {
            result.push(" ");
            currentWidth++;
          }
          result.push(moves[i]);
          currentWidth += moves[i].length;
        }
        return result.join("");
      }
      /**
       * @deprecated Use `setHeader` and `getHeaders` instead. This method will return null header tags (which is not what you want)
       */
      header(...args2) {
        for (let i = 0; i < args2.length; i += 2) {
          if (typeof args2[i] === "string" && typeof args2[i + 1] === "string") {
            this._header[args2[i]] = args2[i + 1];
          }
        }
        return this._header;
      }
      // TODO: value validation per spec
      setHeader(key, value) {
        this._header[key] = value ?? SEVEN_TAG_ROSTER[key] ?? null;
        return this.getHeaders();
      }
      removeHeader(key) {
        if (key in this._header) {
          this._header[key] = SEVEN_TAG_ROSTER[key] || null;
          return true;
        }
        return false;
      }
      // return only non-null headers (omit placemarker nulls)
      getHeaders() {
        const nonNullHeaders = {};
        for (const [key, value] of Object.entries(this._header)) {
          if (value !== null) {
            nonNullHeaders[key] = value;
          }
        }
        return nonNullHeaders;
      }
      loadPgn(pgn2, { strict = false, newlineChar = "\r?\n" } = {}) {
        if (newlineChar !== "\r?\n") {
          pgn2 = pgn2.replace(new RegExp(newlineChar, "g"), "\n");
        }
        const parsedPgn = peg$parse(pgn2);
        this.reset();
        const headers = parsedPgn.headers;
        let fen = "";
        for (const key in headers) {
          if (key.toLowerCase() === "fen") {
            fen = headers[key];
          }
          this.header(key, headers[key]);
        }
        if (!strict) {
          if (fen) {
            this.load(fen, { preserveHeaders: true });
          }
        } else {
          if (headers["SetUp"] === "1") {
            if (!("FEN" in headers)) {
              throw new Error("Invalid PGN: FEN tag must be supplied with SetUp tag");
            }
            this.load(headers["FEN"], { preserveHeaders: true });
          }
        }
        let node2 = parsedPgn.root;
        while (node2) {
          if (node2.move) {
            const move = this._moveFromSan(node2.move, strict);
            if (move == null) {
              throw new Error(`Invalid move in PGN: ${node2.move}`);
            } else {
              this._makeMove(move);
              this._incPositionCount();
            }
          }
          if (node2.comment !== void 0) {
            this._comments[this.fen()] = node2.comment;
          }
          node2 = node2.variations[0];
        }
        const result = parsedPgn.result;
        if (result && Object.keys(this._header).length && this._header["Result"] !== result) {
          this.setHeader("Result", result);
        }
      }
      /*
       * Convert a move from 0x88 coordinates to Standard Algebraic Notation
       * (SAN)
       *
       * @param {boolean} strict Use the strict SAN parser. It will throw errors
       * on overly disambiguated moves (see below):
       *
       * r1bqkbnr/ppp2ppp/2n5/1B1pP3/4P3/8/PPPP2PP/RNBQK1NR b KQkq - 2 4
       * 4. ... Nge7 is overly disambiguated because the knight on c6 is pinned
       * 4. ... Ne7 is technically the valid SAN
       */
      _moveToSan(move, moves) {
        let output = "";
        if (move.flags & BITS.KSIDE_CASTLE) {
          output = "O-O";
        } else if (move.flags & BITS.QSIDE_CASTLE) {
          output = "O-O-O";
        } else if (move.flags & BITS.NULL_MOVE) {
          return SAN_NULLMOVE;
        } else {
          if (move.piece !== PAWN) {
            const disambiguator = getDisambiguator(move, moves);
            output += move.piece.toUpperCase() + disambiguator;
          }
          if (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) {
            if (move.piece === PAWN) {
              output += algebraic(move.from)[0];
            }
            output += "x";
          }
          output += algebraic(move.to);
          if (move.promotion) {
            output += "=" + move.promotion.toUpperCase();
          }
        }
        this._makeMove(move);
        if (this.isCheck()) {
          if (this.isCheckmate()) {
            output += "#";
          } else {
            output += "+";
          }
        }
        this._undoMove();
        return output;
      }
      // convert a move from Standard Algebraic Notation (SAN) to 0x88 coordinates
      _moveFromSan(move, strict = false) {
        let cleanMove = strippedSan(move);
        if (!strict) {
          if (cleanMove === "0-0") {
            cleanMove = "O-O";
          } else if (cleanMove === "0-0-0") {
            cleanMove = "O-O-O";
          }
        }
        if (cleanMove == SAN_NULLMOVE) {
          const res = {
            color: this._turn,
            from: 0,
            to: 0,
            piece: "k",
            flags: BITS.NULL_MOVE
          };
          return res;
        }
        let pieceType = inferPieceType(cleanMove);
        let moves = this._moves({ legal: true, piece: pieceType });
        for (let i = 0, len = moves.length; i < len; i++) {
          if (cleanMove === strippedSan(this._moveToSan(moves[i], moves))) {
            return moves[i];
          }
        }
        if (strict) {
          return null;
        }
        let piece = void 0;
        let matches = void 0;
        let from = void 0;
        let to = void 0;
        let promotion = void 0;
        let overlyDisambiguated = false;
        matches = cleanMove.match(/([pnbrqkPNBRQK])?([a-h][1-8])x?-?([a-h][1-8])([qrbnQRBN])?/);
        if (matches) {
          piece = matches[1];
          from = matches[2];
          to = matches[3];
          promotion = matches[4];
          if (from.length == 1) {
            overlyDisambiguated = true;
          }
        } else {
          matches = cleanMove.match(/([pnbrqkPNBRQK])?([a-h]?[1-8]?)x?-?([a-h][1-8])([qrbnQRBN])?/);
          if (matches) {
            piece = matches[1];
            from = matches[2];
            to = matches[3];
            promotion = matches[4];
            if (from.length == 1) {
              overlyDisambiguated = true;
            }
          }
        }
        pieceType = inferPieceType(cleanMove);
        moves = this._moves({
          legal: true,
          piece: piece ? piece : pieceType
        });
        if (!to) {
          return null;
        }
        for (let i = 0, len = moves.length; i < len; i++) {
          if (!from) {
            if (cleanMove === strippedSan(this._moveToSan(moves[i], moves)).replace("x", "")) {
              return moves[i];
            }
          } else if ((!piece || piece.toLowerCase() == moves[i].piece) && Ox88[from] == moves[i].from && Ox88[to] == moves[i].to && (!promotion || promotion.toLowerCase() == moves[i].promotion)) {
            return moves[i];
          } else if (overlyDisambiguated) {
            const square = algebraic(moves[i].from);
            if ((!piece || piece.toLowerCase() == moves[i].piece) && Ox88[to] == moves[i].to && (from == square[0] || from == square[1]) && (!promotion || promotion.toLowerCase() == moves[i].promotion)) {
              return moves[i];
            }
          }
        }
        return null;
      }
      ascii() {
        let s = "   +------------------------+\n";
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (file(i) === 0) {
            s += " " + "87654321"[rank(i)] + " |";
          }
          if (this._board[i]) {
            const piece = this._board[i].type;
            const color = this._board[i].color;
            const symbol = color === WHITE ? piece.toUpperCase() : piece.toLowerCase();
            s += " " + symbol + " ";
          } else {
            s += " . ";
          }
          if (i + 1 & 136) {
            s += "|\n";
            i += 8;
          }
        }
        s += "   +------------------------+\n";
        s += "     a  b  c  d  e  f  g  h";
        return s;
      }
      perft(depth) {
        const moves = this._moves({ legal: false });
        let nodes = 0;
        const color = this._turn;
        for (let i = 0, len = moves.length; i < len; i++) {
          this._makeMove(moves[i]);
          if (!this._isKingAttacked(color)) {
            if (depth - 1 > 0) {
              nodes += this.perft(depth - 1);
            } else {
              nodes++;
            }
          }
          this._undoMove();
        }
        return nodes;
      }
      setTurn(color) {
        if (this._turn == color) {
          return false;
        }
        this.move("--");
        return true;
      }
      turn() {
        return this._turn;
      }
      board() {
        const output = [];
        let row = [];
        for (let i = Ox88.a8; i <= Ox88.h1; i++) {
          if (this._board[i] == null) {
            row.push(null);
          } else {
            row.push({
              square: algebraic(i),
              type: this._board[i].type,
              color: this._board[i].color
            });
          }
          if (i + 1 & 136) {
            output.push(row);
            row = [];
            i += 8;
          }
        }
        return output;
      }
      squareColor(square) {
        if (square in Ox88) {
          const sq = Ox88[square];
          return (rank(sq) + file(sq)) % 2 === 0 ? "light" : "dark";
        }
        return null;
      }
      history({ verbose = false } = {}) {
        const reversedHistory = [];
        const moveHistory = [];
        while (this._history.length > 0) {
          reversedHistory.push(this._undoMove());
        }
        while (true) {
          const move = reversedHistory.pop();
          if (!move) {
            break;
          }
          if (verbose) {
            moveHistory.push(new Move(this, move));
          } else {
            moveHistory.push(this._moveToSan(move, this._moves()));
          }
          this._makeMove(move);
        }
        return moveHistory;
      }
      /*
       * Keeps track of position occurrence counts for the purpose of repetition
       * checking. Old positions are removed from the map if their counts are reduced to 0.
       */
      _getPositionCount(hash) {
        return this._positionCount.get(hash) ?? 0;
      }
      _incPositionCount() {
        this._positionCount.set(this._hash, (this._positionCount.get(this._hash) ?? 0) + 1);
      }
      _decPositionCount(hash) {
        const currentCount = this._positionCount.get(hash) ?? 0;
        if (currentCount === 1) {
          this._positionCount.delete(hash);
        } else {
          this._positionCount.set(hash, currentCount - 1);
        }
      }
      _pruneComments() {
        const reversedHistory = [];
        const currentComments = {};
        const copyComment = (fen) => {
          if (fen in this._comments) {
            currentComments[fen] = this._comments[fen];
          }
        };
        while (this._history.length > 0) {
          reversedHistory.push(this._undoMove());
        }
        copyComment(this.fen());
        while (true) {
          const move = reversedHistory.pop();
          if (!move) {
            break;
          }
          this._makeMove(move);
          copyComment(this.fen());
        }
        this._comments = currentComments;
      }
      getComment() {
        return this._comments[this.fen()];
      }
      setComment(comment) {
        this._comments[this.fen()] = comment.replace("{", "[").replace("}", "]");
      }
      /**
       * @deprecated Renamed to `removeComment` for consistency
       */
      deleteComment() {
        return this.removeComment();
      }
      removeComment() {
        const comment = this._comments[this.fen()];
        delete this._comments[this.fen()];
        return comment;
      }
      getComments() {
        this._pruneComments();
        return Object.keys(this._comments).map((fen) => {
          return { fen, comment: this._comments[fen] };
        });
      }
      /**
       * @deprecated Renamed to `removeComments` for consistency
       */
      deleteComments() {
        return this.removeComments();
      }
      removeComments() {
        this._pruneComments();
        return Object.keys(this._comments).map((fen) => {
          const comment = this._comments[fen];
          delete this._comments[fen];
          return { fen, comment };
        });
      }
      setCastlingRights(color, rights) {
        for (const side of [KING, QUEEN]) {
          if (rights[side] !== void 0) {
            if (rights[side]) {
              this._castling[color] |= SIDES[side];
            } else {
              this._castling[color] &= ~SIDES[side];
            }
          }
        }
        this._updateCastlingRights();
        const result = this.getCastlingRights(color);
        return (rights[KING] === void 0 || rights[KING] === result[KING]) && (rights[QUEEN] === void 0 || rights[QUEEN] === result[QUEEN]);
      }
      getCastlingRights(color) {
        return {
          [KING]: (this._castling[color] & SIDES[KING]) !== 0,
          [QUEEN]: (this._castling[color] & SIDES[QUEEN]) !== 0
        };
      }
      moveNumber() {
        return this._moveNumber;
      }
    };
    exports2.BISHOP = BISHOP;
    exports2.BLACK = BLACK;
    exports2.Chess = Chess;
    exports2.DEFAULT_POSITION = DEFAULT_POSITION;
    exports2.KING = KING;
    exports2.KNIGHT = KNIGHT;
    exports2.Move = Move;
    exports2.PAWN = PAWN;
    exports2.QUEEN = QUEEN;
    exports2.ROOK = ROOK;
    exports2.SEVEN_TAG_ROSTER = SEVEN_TAG_ROSTER;
    exports2.SQUARES = SQUARES;
    exports2.WHITE = WHITE;
    exports2.validateFen = validateFen;
    exports2.xoroshiro128 = xoroshiro128;
  }
});

// packages/maia-core/dist/data/all_moves_maia3.json
var require_all_moves_maia3 = __commonJS({
  "packages/maia-core/dist/data/all_moves_maia3.json"(exports2, module2) {
    module2.exports = { a1a1: 0, a1b1: 1, a1c1: 2, a1d1: 3, a1e1: 4, a1f1: 5, a1g1: 6, a1h1: 7, a1a2: 8, a1b2: 9, a1c2: 10, a1d2: 11, a1e2: 12, a1f2: 13, a1g2: 14, a1h2: 15, a1a3: 16, a1b3: 17, a1c3: 18, a1d3: 19, a1e3: 20, a1f3: 21, a1g3: 22, a1h3: 23, a1a4: 24, a1b4: 25, a1c4: 26, a1d4: 27, a1e4: 28, a1f4: 29, a1g4: 30, a1h4: 31, a1a5: 32, a1b5: 33, a1c5: 34, a1d5: 35, a1e5: 36, a1f5: 37, a1g5: 38, a1h5: 39, a1a6: 40, a1b6: 41, a1c6: 42, a1d6: 43, a1e6: 44, a1f6: 45, a1g6: 46, a1h6: 47, a1a7: 48, a1b7: 49, a1c7: 50, a1d7: 51, a1e7: 52, a1f7: 53, a1g7: 54, a1h7: 55, a1a8: 56, a1b8: 57, a1c8: 58, a1d8: 59, a1e8: 60, a1f8: 61, a1g8: 62, a1h8: 63, b1a1: 64, b1b1: 65, b1c1: 66, b1d1: 67, b1e1: 68, b1f1: 69, b1g1: 70, b1h1: 71, b1a2: 72, b1b2: 73, b1c2: 74, b1d2: 75, b1e2: 76, b1f2: 77, b1g2: 78, b1h2: 79, b1a3: 80, b1b3: 81, b1c3: 82, b1d3: 83, b1e3: 84, b1f3: 85, b1g3: 86, b1h3: 87, b1a4: 88, b1b4: 89, b1c4: 90, b1d4: 91, b1e4: 92, b1f4: 93, b1g4: 94, b1h4: 95, b1a5: 96, b1b5: 97, b1c5: 98, b1d5: 99, b1e5: 100, b1f5: 101, b1g5: 102, b1h5: 103, b1a6: 104, b1b6: 105, b1c6: 106, b1d6: 107, b1e6: 108, b1f6: 109, b1g6: 110, b1h6: 111, b1a7: 112, b1b7: 113, b1c7: 114, b1d7: 115, b1e7: 116, b1f7: 117, b1g7: 118, b1h7: 119, b1a8: 120, b1b8: 121, b1c8: 122, b1d8: 123, b1e8: 124, b1f8: 125, b1g8: 126, b1h8: 127, c1a1: 128, c1b1: 129, c1c1: 130, c1d1: 131, c1e1: 132, c1f1: 133, c1g1: 134, c1h1: 135, c1a2: 136, c1b2: 137, c1c2: 138, c1d2: 139, c1e2: 140, c1f2: 141, c1g2: 142, c1h2: 143, c1a3: 144, c1b3: 145, c1c3: 146, c1d3: 147, c1e3: 148, c1f3: 149, c1g3: 150, c1h3: 151, c1a4: 152, c1b4: 153, c1c4: 154, c1d4: 155, c1e4: 156, c1f4: 157, c1g4: 158, c1h4: 159, c1a5: 160, c1b5: 161, c1c5: 162, c1d5: 163, c1e5: 164, c1f5: 165, c1g5: 166, c1h5: 167, c1a6: 168, c1b6: 169, c1c6: 170, c1d6: 171, c1e6: 172, c1f6: 173, c1g6: 174, c1h6: 175, c1a7: 176, c1b7: 177, c1c7: 178, c1d7: 179, c1e7: 180, c1f7: 181, c1g7: 182, c1h7: 183, c1a8: 184, c1b8: 185, c1c8: 186, c1d8: 187, c1e8: 188, c1f8: 189, c1g8: 190, c1h8: 191, d1a1: 192, d1b1: 193, d1c1: 194, d1d1: 195, d1e1: 196, d1f1: 197, d1g1: 198, d1h1: 199, d1a2: 200, d1b2: 201, d1c2: 202, d1d2: 203, d1e2: 204, d1f2: 205, d1g2: 206, d1h2: 207, d1a3: 208, d1b3: 209, d1c3: 210, d1d3: 211, d1e3: 212, d1f3: 213, d1g3: 214, d1h3: 215, d1a4: 216, d1b4: 217, d1c4: 218, d1d4: 219, d1e4: 220, d1f4: 221, d1g4: 222, d1h4: 223, d1a5: 224, d1b5: 225, d1c5: 226, d1d5: 227, d1e5: 228, d1f5: 229, d1g5: 230, d1h5: 231, d1a6: 232, d1b6: 233, d1c6: 234, d1d6: 235, d1e6: 236, d1f6: 237, d1g6: 238, d1h6: 239, d1a7: 240, d1b7: 241, d1c7: 242, d1d7: 243, d1e7: 244, d1f7: 245, d1g7: 246, d1h7: 247, d1a8: 248, d1b8: 249, d1c8: 250, d1d8: 251, d1e8: 252, d1f8: 253, d1g8: 254, d1h8: 255, e1a1: 256, e1b1: 257, e1c1: 258, e1d1: 259, e1e1: 260, e1f1: 261, e1g1: 262, e1h1: 263, e1a2: 264, e1b2: 265, e1c2: 266, e1d2: 267, e1e2: 268, e1f2: 269, e1g2: 270, e1h2: 271, e1a3: 272, e1b3: 273, e1c3: 274, e1d3: 275, e1e3: 276, e1f3: 277, e1g3: 278, e1h3: 279, e1a4: 280, e1b4: 281, e1c4: 282, e1d4: 283, e1e4: 284, e1f4: 285, e1g4: 286, e1h4: 287, e1a5: 288, e1b5: 289, e1c5: 290, e1d5: 291, e1e5: 292, e1f5: 293, e1g5: 294, e1h5: 295, e1a6: 296, e1b6: 297, e1c6: 298, e1d6: 299, e1e6: 300, e1f6: 301, e1g6: 302, e1h6: 303, e1a7: 304, e1b7: 305, e1c7: 306, e1d7: 307, e1e7: 308, e1f7: 309, e1g7: 310, e1h7: 311, e1a8: 312, e1b8: 313, e1c8: 314, e1d8: 315, e1e8: 316, e1f8: 317, e1g8: 318, e1h8: 319, f1a1: 320, f1b1: 321, f1c1: 322, f1d1: 323, f1e1: 324, f1f1: 325, f1g1: 326, f1h1: 327, f1a2: 328, f1b2: 329, f1c2: 330, f1d2: 331, f1e2: 332, f1f2: 333, f1g2: 334, f1h2: 335, f1a3: 336, f1b3: 337, f1c3: 338, f1d3: 339, f1e3: 340, f1f3: 341, f1g3: 342, f1h3: 343, f1a4: 344, f1b4: 345, f1c4: 346, f1d4: 347, f1e4: 348, f1f4: 349, f1g4: 350, f1h4: 351, f1a5: 352, f1b5: 353, f1c5: 354, f1d5: 355, f1e5: 356, f1f5: 357, f1g5: 358, f1h5: 359, f1a6: 360, f1b6: 361, f1c6: 362, f1d6: 363, f1e6: 364, f1f6: 365, f1g6: 366, f1h6: 367, f1a7: 368, f1b7: 369, f1c7: 370, f1d7: 371, f1e7: 372, f1f7: 373, f1g7: 374, f1h7: 375, f1a8: 376, f1b8: 377, f1c8: 378, f1d8: 379, f1e8: 380, f1f8: 381, f1g8: 382, f1h8: 383, g1a1: 384, g1b1: 385, g1c1: 386, g1d1: 387, g1e1: 388, g1f1: 389, g1g1: 390, g1h1: 391, g1a2: 392, g1b2: 393, g1c2: 394, g1d2: 395, g1e2: 396, g1f2: 397, g1g2: 398, g1h2: 399, g1a3: 400, g1b3: 401, g1c3: 402, g1d3: 403, g1e3: 404, g1f3: 405, g1g3: 406, g1h3: 407, g1a4: 408, g1b4: 409, g1c4: 410, g1d4: 411, g1e4: 412, g1f4: 413, g1g4: 414, g1h4: 415, g1a5: 416, g1b5: 417, g1c5: 418, g1d5: 419, g1e5: 420, g1f5: 421, g1g5: 422, g1h5: 423, g1a6: 424, g1b6: 425, g1c6: 426, g1d6: 427, g1e6: 428, g1f6: 429, g1g6: 430, g1h6: 431, g1a7: 432, g1b7: 433, g1c7: 434, g1d7: 435, g1e7: 436, g1f7: 437, g1g7: 438, g1h7: 439, g1a8: 440, g1b8: 441, g1c8: 442, g1d8: 443, g1e8: 444, g1f8: 445, g1g8: 446, g1h8: 447, h1a1: 448, h1b1: 449, h1c1: 450, h1d1: 451, h1e1: 452, h1f1: 453, h1g1: 454, h1h1: 455, h1a2: 456, h1b2: 457, h1c2: 458, h1d2: 459, h1e2: 460, h1f2: 461, h1g2: 462, h1h2: 463, h1a3: 464, h1b3: 465, h1c3: 466, h1d3: 467, h1e3: 468, h1f3: 469, h1g3: 470, h1h3: 471, h1a4: 472, h1b4: 473, h1c4: 474, h1d4: 475, h1e4: 476, h1f4: 477, h1g4: 478, h1h4: 479, h1a5: 480, h1b5: 481, h1c5: 482, h1d5: 483, h1e5: 484, h1f5: 485, h1g5: 486, h1h5: 487, h1a6: 488, h1b6: 489, h1c6: 490, h1d6: 491, h1e6: 492, h1f6: 493, h1g6: 494, h1h6: 495, h1a7: 496, h1b7: 497, h1c7: 498, h1d7: 499, h1e7: 500, h1f7: 501, h1g7: 502, h1h7: 503, h1a8: 504, h1b8: 505, h1c8: 506, h1d8: 507, h1e8: 508, h1f8: 509, h1g8: 510, h1h8: 511, a2a1: 512, a2b1: 513, a2c1: 514, a2d1: 515, a2e1: 516, a2f1: 517, a2g1: 518, a2h1: 519, a2a2: 520, a2b2: 521, a2c2: 522, a2d2: 523, a2e2: 524, a2f2: 525, a2g2: 526, a2h2: 527, a2a3: 528, a2b3: 529, a2c3: 530, a2d3: 531, a2e3: 532, a2f3: 533, a2g3: 534, a2h3: 535, a2a4: 536, a2b4: 537, a2c4: 538, a2d4: 539, a2e4: 540, a2f4: 541, a2g4: 542, a2h4: 543, a2a5: 544, a2b5: 545, a2c5: 546, a2d5: 547, a2e5: 548, a2f5: 549, a2g5: 550, a2h5: 551, a2a6: 552, a2b6: 553, a2c6: 554, a2d6: 555, a2e6: 556, a2f6: 557, a2g6: 558, a2h6: 559, a2a7: 560, a2b7: 561, a2c7: 562, a2d7: 563, a2e7: 564, a2f7: 565, a2g7: 566, a2h7: 567, a2a8: 568, a2b8: 569, a2c8: 570, a2d8: 571, a2e8: 572, a2f8: 573, a2g8: 574, a2h8: 575, b2a1: 576, b2b1: 577, b2c1: 578, b2d1: 579, b2e1: 580, b2f1: 581, b2g1: 582, b2h1: 583, b2a2: 584, b2b2: 585, b2c2: 586, b2d2: 587, b2e2: 588, b2f2: 589, b2g2: 590, b2h2: 591, b2a3: 592, b2b3: 593, b2c3: 594, b2d3: 595, b2e3: 596, b2f3: 597, b2g3: 598, b2h3: 599, b2a4: 600, b2b4: 601, b2c4: 602, b2d4: 603, b2e4: 604, b2f4: 605, b2g4: 606, b2h4: 607, b2a5: 608, b2b5: 609, b2c5: 610, b2d5: 611, b2e5: 612, b2f5: 613, b2g5: 614, b2h5: 615, b2a6: 616, b2b6: 617, b2c6: 618, b2d6: 619, b2e6: 620, b2f6: 621, b2g6: 622, b2h6: 623, b2a7: 624, b2b7: 625, b2c7: 626, b2d7: 627, b2e7: 628, b2f7: 629, b2g7: 630, b2h7: 631, b2a8: 632, b2b8: 633, b2c8: 634, b2d8: 635, b2e8: 636, b2f8: 637, b2g8: 638, b2h8: 639, c2a1: 640, c2b1: 641, c2c1: 642, c2d1: 643, c2e1: 644, c2f1: 645, c2g1: 646, c2h1: 647, c2a2: 648, c2b2: 649, c2c2: 650, c2d2: 651, c2e2: 652, c2f2: 653, c2g2: 654, c2h2: 655, c2a3: 656, c2b3: 657, c2c3: 658, c2d3: 659, c2e3: 660, c2f3: 661, c2g3: 662, c2h3: 663, c2a4: 664, c2b4: 665, c2c4: 666, c2d4: 667, c2e4: 668, c2f4: 669, c2g4: 670, c2h4: 671, c2a5: 672, c2b5: 673, c2c5: 674, c2d5: 675, c2e5: 676, c2f5: 677, c2g5: 678, c2h5: 679, c2a6: 680, c2b6: 681, c2c6: 682, c2d6: 683, c2e6: 684, c2f6: 685, c2g6: 686, c2h6: 687, c2a7: 688, c2b7: 689, c2c7: 690, c2d7: 691, c2e7: 692, c2f7: 693, c2g7: 694, c2h7: 695, c2a8: 696, c2b8: 697, c2c8: 698, c2d8: 699, c2e8: 700, c2f8: 701, c2g8: 702, c2h8: 703, d2a1: 704, d2b1: 705, d2c1: 706, d2d1: 707, d2e1: 708, d2f1: 709, d2g1: 710, d2h1: 711, d2a2: 712, d2b2: 713, d2c2: 714, d2d2: 715, d2e2: 716, d2f2: 717, d2g2: 718, d2h2: 719, d2a3: 720, d2b3: 721, d2c3: 722, d2d3: 723, d2e3: 724, d2f3: 725, d2g3: 726, d2h3: 727, d2a4: 728, d2b4: 729, d2c4: 730, d2d4: 731, d2e4: 732, d2f4: 733, d2g4: 734, d2h4: 735, d2a5: 736, d2b5: 737, d2c5: 738, d2d5: 739, d2e5: 740, d2f5: 741, d2g5: 742, d2h5: 743, d2a6: 744, d2b6: 745, d2c6: 746, d2d6: 747, d2e6: 748, d2f6: 749, d2g6: 750, d2h6: 751, d2a7: 752, d2b7: 753, d2c7: 754, d2d7: 755, d2e7: 756, d2f7: 757, d2g7: 758, d2h7: 759, d2a8: 760, d2b8: 761, d2c8: 762, d2d8: 763, d2e8: 764, d2f8: 765, d2g8: 766, d2h8: 767, e2a1: 768, e2b1: 769, e2c1: 770, e2d1: 771, e2e1: 772, e2f1: 773, e2g1: 774, e2h1: 775, e2a2: 776, e2b2: 777, e2c2: 778, e2d2: 779, e2e2: 780, e2f2: 781, e2g2: 782, e2h2: 783, e2a3: 784, e2b3: 785, e2c3: 786, e2d3: 787, e2e3: 788, e2f3: 789, e2g3: 790, e2h3: 791, e2a4: 792, e2b4: 793, e2c4: 794, e2d4: 795, e2e4: 796, e2f4: 797, e2g4: 798, e2h4: 799, e2a5: 800, e2b5: 801, e2c5: 802, e2d5: 803, e2e5: 804, e2f5: 805, e2g5: 806, e2h5: 807, e2a6: 808, e2b6: 809, e2c6: 810, e2d6: 811, e2e6: 812, e2f6: 813, e2g6: 814, e2h6: 815, e2a7: 816, e2b7: 817, e2c7: 818, e2d7: 819, e2e7: 820, e2f7: 821, e2g7: 822, e2h7: 823, e2a8: 824, e2b8: 825, e2c8: 826, e2d8: 827, e2e8: 828, e2f8: 829, e2g8: 830, e2h8: 831, f2a1: 832, f2b1: 833, f2c1: 834, f2d1: 835, f2e1: 836, f2f1: 837, f2g1: 838, f2h1: 839, f2a2: 840, f2b2: 841, f2c2: 842, f2d2: 843, f2e2: 844, f2f2: 845, f2g2: 846, f2h2: 847, f2a3: 848, f2b3: 849, f2c3: 850, f2d3: 851, f2e3: 852, f2f3: 853, f2g3: 854, f2h3: 855, f2a4: 856, f2b4: 857, f2c4: 858, f2d4: 859, f2e4: 860, f2f4: 861, f2g4: 862, f2h4: 863, f2a5: 864, f2b5: 865, f2c5: 866, f2d5: 867, f2e5: 868, f2f5: 869, f2g5: 870, f2h5: 871, f2a6: 872, f2b6: 873, f2c6: 874, f2d6: 875, f2e6: 876, f2f6: 877, f2g6: 878, f2h6: 879, f2a7: 880, f2b7: 881, f2c7: 882, f2d7: 883, f2e7: 884, f2f7: 885, f2g7: 886, f2h7: 887, f2a8: 888, f2b8: 889, f2c8: 890, f2d8: 891, f2e8: 892, f2f8: 893, f2g8: 894, f2h8: 895, g2a1: 896, g2b1: 897, g2c1: 898, g2d1: 899, g2e1: 900, g2f1: 901, g2g1: 902, g2h1: 903, g2a2: 904, g2b2: 905, g2c2: 906, g2d2: 907, g2e2: 908, g2f2: 909, g2g2: 910, g2h2: 911, g2a3: 912, g2b3: 913, g2c3: 914, g2d3: 915, g2e3: 916, g2f3: 917, g2g3: 918, g2h3: 919, g2a4: 920, g2b4: 921, g2c4: 922, g2d4: 923, g2e4: 924, g2f4: 925, g2g4: 926, g2h4: 927, g2a5: 928, g2b5: 929, g2c5: 930, g2d5: 931, g2e5: 932, g2f5: 933, g2g5: 934, g2h5: 935, g2a6: 936, g2b6: 937, g2c6: 938, g2d6: 939, g2e6: 940, g2f6: 941, g2g6: 942, g2h6: 943, g2a7: 944, g2b7: 945, g2c7: 946, g2d7: 947, g2e7: 948, g2f7: 949, g2g7: 950, g2h7: 951, g2a8: 952, g2b8: 953, g2c8: 954, g2d8: 955, g2e8: 956, g2f8: 957, g2g8: 958, g2h8: 959, h2a1: 960, h2b1: 961, h2c1: 962, h2d1: 963, h2e1: 964, h2f1: 965, h2g1: 966, h2h1: 967, h2a2: 968, h2b2: 969, h2c2: 970, h2d2: 971, h2e2: 972, h2f2: 973, h2g2: 974, h2h2: 975, h2a3: 976, h2b3: 977, h2c3: 978, h2d3: 979, h2e3: 980, h2f3: 981, h2g3: 982, h2h3: 983, h2a4: 984, h2b4: 985, h2c4: 986, h2d4: 987, h2e4: 988, h2f4: 989, h2g4: 990, h2h4: 991, h2a5: 992, h2b5: 993, h2c5: 994, h2d5: 995, h2e5: 996, h2f5: 997, h2g5: 998, h2h5: 999, h2a6: 1e3, h2b6: 1001, h2c6: 1002, h2d6: 1003, h2e6: 1004, h2f6: 1005, h2g6: 1006, h2h6: 1007, h2a7: 1008, h2b7: 1009, h2c7: 1010, h2d7: 1011, h2e7: 1012, h2f7: 1013, h2g7: 1014, h2h7: 1015, h2a8: 1016, h2b8: 1017, h2c8: 1018, h2d8: 1019, h2e8: 1020, h2f8: 1021, h2g8: 1022, h2h8: 1023, a3a1: 1024, a3b1: 1025, a3c1: 1026, a3d1: 1027, a3e1: 1028, a3f1: 1029, a3g1: 1030, a3h1: 1031, a3a2: 1032, a3b2: 1033, a3c2: 1034, a3d2: 1035, a3e2: 1036, a3f2: 1037, a3g2: 1038, a3h2: 1039, a3a3: 1040, a3b3: 1041, a3c3: 1042, a3d3: 1043, a3e3: 1044, a3f3: 1045, a3g3: 1046, a3h3: 1047, a3a4: 1048, a3b4: 1049, a3c4: 1050, a3d4: 1051, a3e4: 1052, a3f4: 1053, a3g4: 1054, a3h4: 1055, a3a5: 1056, a3b5: 1057, a3c5: 1058, a3d5: 1059, a3e5: 1060, a3f5: 1061, a3g5: 1062, a3h5: 1063, a3a6: 1064, a3b6: 1065, a3c6: 1066, a3d6: 1067, a3e6: 1068, a3f6: 1069, a3g6: 1070, a3h6: 1071, a3a7: 1072, a3b7: 1073, a3c7: 1074, a3d7: 1075, a3e7: 1076, a3f7: 1077, a3g7: 1078, a3h7: 1079, a3a8: 1080, a3b8: 1081, a3c8: 1082, a3d8: 1083, a3e8: 1084, a3f8: 1085, a3g8: 1086, a3h8: 1087, b3a1: 1088, b3b1: 1089, b3c1: 1090, b3d1: 1091, b3e1: 1092, b3f1: 1093, b3g1: 1094, b3h1: 1095, b3a2: 1096, b3b2: 1097, b3c2: 1098, b3d2: 1099, b3e2: 1100, b3f2: 1101, b3g2: 1102, b3h2: 1103, b3a3: 1104, b3b3: 1105, b3c3: 1106, b3d3: 1107, b3e3: 1108, b3f3: 1109, b3g3: 1110, b3h3: 1111, b3a4: 1112, b3b4: 1113, b3c4: 1114, b3d4: 1115, b3e4: 1116, b3f4: 1117, b3g4: 1118, b3h4: 1119, b3a5: 1120, b3b5: 1121, b3c5: 1122, b3d5: 1123, b3e5: 1124, b3f5: 1125, b3g5: 1126, b3h5: 1127, b3a6: 1128, b3b6: 1129, b3c6: 1130, b3d6: 1131, b3e6: 1132, b3f6: 1133, b3g6: 1134, b3h6: 1135, b3a7: 1136, b3b7: 1137, b3c7: 1138, b3d7: 1139, b3e7: 1140, b3f7: 1141, b3g7: 1142, b3h7: 1143, b3a8: 1144, b3b8: 1145, b3c8: 1146, b3d8: 1147, b3e8: 1148, b3f8: 1149, b3g8: 1150, b3h8: 1151, c3a1: 1152, c3b1: 1153, c3c1: 1154, c3d1: 1155, c3e1: 1156, c3f1: 1157, c3g1: 1158, c3h1: 1159, c3a2: 1160, c3b2: 1161, c3c2: 1162, c3d2: 1163, c3e2: 1164, c3f2: 1165, c3g2: 1166, c3h2: 1167, c3a3: 1168, c3b3: 1169, c3c3: 1170, c3d3: 1171, c3e3: 1172, c3f3: 1173, c3g3: 1174, c3h3: 1175, c3a4: 1176, c3b4: 1177, c3c4: 1178, c3d4: 1179, c3e4: 1180, c3f4: 1181, c3g4: 1182, c3h4: 1183, c3a5: 1184, c3b5: 1185, c3c5: 1186, c3d5: 1187, c3e5: 1188, c3f5: 1189, c3g5: 1190, c3h5: 1191, c3a6: 1192, c3b6: 1193, c3c6: 1194, c3d6: 1195, c3e6: 1196, c3f6: 1197, c3g6: 1198, c3h6: 1199, c3a7: 1200, c3b7: 1201, c3c7: 1202, c3d7: 1203, c3e7: 1204, c3f7: 1205, c3g7: 1206, c3h7: 1207, c3a8: 1208, c3b8: 1209, c3c8: 1210, c3d8: 1211, c3e8: 1212, c3f8: 1213, c3g8: 1214, c3h8: 1215, d3a1: 1216, d3b1: 1217, d3c1: 1218, d3d1: 1219, d3e1: 1220, d3f1: 1221, d3g1: 1222, d3h1: 1223, d3a2: 1224, d3b2: 1225, d3c2: 1226, d3d2: 1227, d3e2: 1228, d3f2: 1229, d3g2: 1230, d3h2: 1231, d3a3: 1232, d3b3: 1233, d3c3: 1234, d3d3: 1235, d3e3: 1236, d3f3: 1237, d3g3: 1238, d3h3: 1239, d3a4: 1240, d3b4: 1241, d3c4: 1242, d3d4: 1243, d3e4: 1244, d3f4: 1245, d3g4: 1246, d3h4: 1247, d3a5: 1248, d3b5: 1249, d3c5: 1250, d3d5: 1251, d3e5: 1252, d3f5: 1253, d3g5: 1254, d3h5: 1255, d3a6: 1256, d3b6: 1257, d3c6: 1258, d3d6: 1259, d3e6: 1260, d3f6: 1261, d3g6: 1262, d3h6: 1263, d3a7: 1264, d3b7: 1265, d3c7: 1266, d3d7: 1267, d3e7: 1268, d3f7: 1269, d3g7: 1270, d3h7: 1271, d3a8: 1272, d3b8: 1273, d3c8: 1274, d3d8: 1275, d3e8: 1276, d3f8: 1277, d3g8: 1278, d3h8: 1279, e3a1: 1280, e3b1: 1281, e3c1: 1282, e3d1: 1283, e3e1: 1284, e3f1: 1285, e3g1: 1286, e3h1: 1287, e3a2: 1288, e3b2: 1289, e3c2: 1290, e3d2: 1291, e3e2: 1292, e3f2: 1293, e3g2: 1294, e3h2: 1295, e3a3: 1296, e3b3: 1297, e3c3: 1298, e3d3: 1299, e3e3: 1300, e3f3: 1301, e3g3: 1302, e3h3: 1303, e3a4: 1304, e3b4: 1305, e3c4: 1306, e3d4: 1307, e3e4: 1308, e3f4: 1309, e3g4: 1310, e3h4: 1311, e3a5: 1312, e3b5: 1313, e3c5: 1314, e3d5: 1315, e3e5: 1316, e3f5: 1317, e3g5: 1318, e3h5: 1319, e3a6: 1320, e3b6: 1321, e3c6: 1322, e3d6: 1323, e3e6: 1324, e3f6: 1325, e3g6: 1326, e3h6: 1327, e3a7: 1328, e3b7: 1329, e3c7: 1330, e3d7: 1331, e3e7: 1332, e3f7: 1333, e3g7: 1334, e3h7: 1335, e3a8: 1336, e3b8: 1337, e3c8: 1338, e3d8: 1339, e3e8: 1340, e3f8: 1341, e3g8: 1342, e3h8: 1343, f3a1: 1344, f3b1: 1345, f3c1: 1346, f3d1: 1347, f3e1: 1348, f3f1: 1349, f3g1: 1350, f3h1: 1351, f3a2: 1352, f3b2: 1353, f3c2: 1354, f3d2: 1355, f3e2: 1356, f3f2: 1357, f3g2: 1358, f3h2: 1359, f3a3: 1360, f3b3: 1361, f3c3: 1362, f3d3: 1363, f3e3: 1364, f3f3: 1365, f3g3: 1366, f3h3: 1367, f3a4: 1368, f3b4: 1369, f3c4: 1370, f3d4: 1371, f3e4: 1372, f3f4: 1373, f3g4: 1374, f3h4: 1375, f3a5: 1376, f3b5: 1377, f3c5: 1378, f3d5: 1379, f3e5: 1380, f3f5: 1381, f3g5: 1382, f3h5: 1383, f3a6: 1384, f3b6: 1385, f3c6: 1386, f3d6: 1387, f3e6: 1388, f3f6: 1389, f3g6: 1390, f3h6: 1391, f3a7: 1392, f3b7: 1393, f3c7: 1394, f3d7: 1395, f3e7: 1396, f3f7: 1397, f3g7: 1398, f3h7: 1399, f3a8: 1400, f3b8: 1401, f3c8: 1402, f3d8: 1403, f3e8: 1404, f3f8: 1405, f3g8: 1406, f3h8: 1407, g3a1: 1408, g3b1: 1409, g3c1: 1410, g3d1: 1411, g3e1: 1412, g3f1: 1413, g3g1: 1414, g3h1: 1415, g3a2: 1416, g3b2: 1417, g3c2: 1418, g3d2: 1419, g3e2: 1420, g3f2: 1421, g3g2: 1422, g3h2: 1423, g3a3: 1424, g3b3: 1425, g3c3: 1426, g3d3: 1427, g3e3: 1428, g3f3: 1429, g3g3: 1430, g3h3: 1431, g3a4: 1432, g3b4: 1433, g3c4: 1434, g3d4: 1435, g3e4: 1436, g3f4: 1437, g3g4: 1438, g3h4: 1439, g3a5: 1440, g3b5: 1441, g3c5: 1442, g3d5: 1443, g3e5: 1444, g3f5: 1445, g3g5: 1446, g3h5: 1447, g3a6: 1448, g3b6: 1449, g3c6: 1450, g3d6: 1451, g3e6: 1452, g3f6: 1453, g3g6: 1454, g3h6: 1455, g3a7: 1456, g3b7: 1457, g3c7: 1458, g3d7: 1459, g3e7: 1460, g3f7: 1461, g3g7: 1462, g3h7: 1463, g3a8: 1464, g3b8: 1465, g3c8: 1466, g3d8: 1467, g3e8: 1468, g3f8: 1469, g3g8: 1470, g3h8: 1471, h3a1: 1472, h3b1: 1473, h3c1: 1474, h3d1: 1475, h3e1: 1476, h3f1: 1477, h3g1: 1478, h3h1: 1479, h3a2: 1480, h3b2: 1481, h3c2: 1482, h3d2: 1483, h3e2: 1484, h3f2: 1485, h3g2: 1486, h3h2: 1487, h3a3: 1488, h3b3: 1489, h3c3: 1490, h3d3: 1491, h3e3: 1492, h3f3: 1493, h3g3: 1494, h3h3: 1495, h3a4: 1496, h3b4: 1497, h3c4: 1498, h3d4: 1499, h3e4: 1500, h3f4: 1501, h3g4: 1502, h3h4: 1503, h3a5: 1504, h3b5: 1505, h3c5: 1506, h3d5: 1507, h3e5: 1508, h3f5: 1509, h3g5: 1510, h3h5: 1511, h3a6: 1512, h3b6: 1513, h3c6: 1514, h3d6: 1515, h3e6: 1516, h3f6: 1517, h3g6: 1518, h3h6: 1519, h3a7: 1520, h3b7: 1521, h3c7: 1522, h3d7: 1523, h3e7: 1524, h3f7: 1525, h3g7: 1526, h3h7: 1527, h3a8: 1528, h3b8: 1529, h3c8: 1530, h3d8: 1531, h3e8: 1532, h3f8: 1533, h3g8: 1534, h3h8: 1535, a4a1: 1536, a4b1: 1537, a4c1: 1538, a4d1: 1539, a4e1: 1540, a4f1: 1541, a4g1: 1542, a4h1: 1543, a4a2: 1544, a4b2: 1545, a4c2: 1546, a4d2: 1547, a4e2: 1548, a4f2: 1549, a4g2: 1550, a4h2: 1551, a4a3: 1552, a4b3: 1553, a4c3: 1554, a4d3: 1555, a4e3: 1556, a4f3: 1557, a4g3: 1558, a4h3: 1559, a4a4: 1560, a4b4: 1561, a4c4: 1562, a4d4: 1563, a4e4: 1564, a4f4: 1565, a4g4: 1566, a4h4: 1567, a4a5: 1568, a4b5: 1569, a4c5: 1570, a4d5: 1571, a4e5: 1572, a4f5: 1573, a4g5: 1574, a4h5: 1575, a4a6: 1576, a4b6: 1577, a4c6: 1578, a4d6: 1579, a4e6: 1580, a4f6: 1581, a4g6: 1582, a4h6: 1583, a4a7: 1584, a4b7: 1585, a4c7: 1586, a4d7: 1587, a4e7: 1588, a4f7: 1589, a4g7: 1590, a4h7: 1591, a4a8: 1592, a4b8: 1593, a4c8: 1594, a4d8: 1595, a4e8: 1596, a4f8: 1597, a4g8: 1598, a4h8: 1599, b4a1: 1600, b4b1: 1601, b4c1: 1602, b4d1: 1603, b4e1: 1604, b4f1: 1605, b4g1: 1606, b4h1: 1607, b4a2: 1608, b4b2: 1609, b4c2: 1610, b4d2: 1611, b4e2: 1612, b4f2: 1613, b4g2: 1614, b4h2: 1615, b4a3: 1616, b4b3: 1617, b4c3: 1618, b4d3: 1619, b4e3: 1620, b4f3: 1621, b4g3: 1622, b4h3: 1623, b4a4: 1624, b4b4: 1625, b4c4: 1626, b4d4: 1627, b4e4: 1628, b4f4: 1629, b4g4: 1630, b4h4: 1631, b4a5: 1632, b4b5: 1633, b4c5: 1634, b4d5: 1635, b4e5: 1636, b4f5: 1637, b4g5: 1638, b4h5: 1639, b4a6: 1640, b4b6: 1641, b4c6: 1642, b4d6: 1643, b4e6: 1644, b4f6: 1645, b4g6: 1646, b4h6: 1647, b4a7: 1648, b4b7: 1649, b4c7: 1650, b4d7: 1651, b4e7: 1652, b4f7: 1653, b4g7: 1654, b4h7: 1655, b4a8: 1656, b4b8: 1657, b4c8: 1658, b4d8: 1659, b4e8: 1660, b4f8: 1661, b4g8: 1662, b4h8: 1663, c4a1: 1664, c4b1: 1665, c4c1: 1666, c4d1: 1667, c4e1: 1668, c4f1: 1669, c4g1: 1670, c4h1: 1671, c4a2: 1672, c4b2: 1673, c4c2: 1674, c4d2: 1675, c4e2: 1676, c4f2: 1677, c4g2: 1678, c4h2: 1679, c4a3: 1680, c4b3: 1681, c4c3: 1682, c4d3: 1683, c4e3: 1684, c4f3: 1685, c4g3: 1686, c4h3: 1687, c4a4: 1688, c4b4: 1689, c4c4: 1690, c4d4: 1691, c4e4: 1692, c4f4: 1693, c4g4: 1694, c4h4: 1695, c4a5: 1696, c4b5: 1697, c4c5: 1698, c4d5: 1699, c4e5: 1700, c4f5: 1701, c4g5: 1702, c4h5: 1703, c4a6: 1704, c4b6: 1705, c4c6: 1706, c4d6: 1707, c4e6: 1708, c4f6: 1709, c4g6: 1710, c4h6: 1711, c4a7: 1712, c4b7: 1713, c4c7: 1714, c4d7: 1715, c4e7: 1716, c4f7: 1717, c4g7: 1718, c4h7: 1719, c4a8: 1720, c4b8: 1721, c4c8: 1722, c4d8: 1723, c4e8: 1724, c4f8: 1725, c4g8: 1726, c4h8: 1727, d4a1: 1728, d4b1: 1729, d4c1: 1730, d4d1: 1731, d4e1: 1732, d4f1: 1733, d4g1: 1734, d4h1: 1735, d4a2: 1736, d4b2: 1737, d4c2: 1738, d4d2: 1739, d4e2: 1740, d4f2: 1741, d4g2: 1742, d4h2: 1743, d4a3: 1744, d4b3: 1745, d4c3: 1746, d4d3: 1747, d4e3: 1748, d4f3: 1749, d4g3: 1750, d4h3: 1751, d4a4: 1752, d4b4: 1753, d4c4: 1754, d4d4: 1755, d4e4: 1756, d4f4: 1757, d4g4: 1758, d4h4: 1759, d4a5: 1760, d4b5: 1761, d4c5: 1762, d4d5: 1763, d4e5: 1764, d4f5: 1765, d4g5: 1766, d4h5: 1767, d4a6: 1768, d4b6: 1769, d4c6: 1770, d4d6: 1771, d4e6: 1772, d4f6: 1773, d4g6: 1774, d4h6: 1775, d4a7: 1776, d4b7: 1777, d4c7: 1778, d4d7: 1779, d4e7: 1780, d4f7: 1781, d4g7: 1782, d4h7: 1783, d4a8: 1784, d4b8: 1785, d4c8: 1786, d4d8: 1787, d4e8: 1788, d4f8: 1789, d4g8: 1790, d4h8: 1791, e4a1: 1792, e4b1: 1793, e4c1: 1794, e4d1: 1795, e4e1: 1796, e4f1: 1797, e4g1: 1798, e4h1: 1799, e4a2: 1800, e4b2: 1801, e4c2: 1802, e4d2: 1803, e4e2: 1804, e4f2: 1805, e4g2: 1806, e4h2: 1807, e4a3: 1808, e4b3: 1809, e4c3: 1810, e4d3: 1811, e4e3: 1812, e4f3: 1813, e4g3: 1814, e4h3: 1815, e4a4: 1816, e4b4: 1817, e4c4: 1818, e4d4: 1819, e4e4: 1820, e4f4: 1821, e4g4: 1822, e4h4: 1823, e4a5: 1824, e4b5: 1825, e4c5: 1826, e4d5: 1827, e4e5: 1828, e4f5: 1829, e4g5: 1830, e4h5: 1831, e4a6: 1832, e4b6: 1833, e4c6: 1834, e4d6: 1835, e4e6: 1836, e4f6: 1837, e4g6: 1838, e4h6: 1839, e4a7: 1840, e4b7: 1841, e4c7: 1842, e4d7: 1843, e4e7: 1844, e4f7: 1845, e4g7: 1846, e4h7: 1847, e4a8: 1848, e4b8: 1849, e4c8: 1850, e4d8: 1851, e4e8: 1852, e4f8: 1853, e4g8: 1854, e4h8: 1855, f4a1: 1856, f4b1: 1857, f4c1: 1858, f4d1: 1859, f4e1: 1860, f4f1: 1861, f4g1: 1862, f4h1: 1863, f4a2: 1864, f4b2: 1865, f4c2: 1866, f4d2: 1867, f4e2: 1868, f4f2: 1869, f4g2: 1870, f4h2: 1871, f4a3: 1872, f4b3: 1873, f4c3: 1874, f4d3: 1875, f4e3: 1876, f4f3: 1877, f4g3: 1878, f4h3: 1879, f4a4: 1880, f4b4: 1881, f4c4: 1882, f4d4: 1883, f4e4: 1884, f4f4: 1885, f4g4: 1886, f4h4: 1887, f4a5: 1888, f4b5: 1889, f4c5: 1890, f4d5: 1891, f4e5: 1892, f4f5: 1893, f4g5: 1894, f4h5: 1895, f4a6: 1896, f4b6: 1897, f4c6: 1898, f4d6: 1899, f4e6: 1900, f4f6: 1901, f4g6: 1902, f4h6: 1903, f4a7: 1904, f4b7: 1905, f4c7: 1906, f4d7: 1907, f4e7: 1908, f4f7: 1909, f4g7: 1910, f4h7: 1911, f4a8: 1912, f4b8: 1913, f4c8: 1914, f4d8: 1915, f4e8: 1916, f4f8: 1917, f4g8: 1918, f4h8: 1919, g4a1: 1920, g4b1: 1921, g4c1: 1922, g4d1: 1923, g4e1: 1924, g4f1: 1925, g4g1: 1926, g4h1: 1927, g4a2: 1928, g4b2: 1929, g4c2: 1930, g4d2: 1931, g4e2: 1932, g4f2: 1933, g4g2: 1934, g4h2: 1935, g4a3: 1936, g4b3: 1937, g4c3: 1938, g4d3: 1939, g4e3: 1940, g4f3: 1941, g4g3: 1942, g4h3: 1943, g4a4: 1944, g4b4: 1945, g4c4: 1946, g4d4: 1947, g4e4: 1948, g4f4: 1949, g4g4: 1950, g4h4: 1951, g4a5: 1952, g4b5: 1953, g4c5: 1954, g4d5: 1955, g4e5: 1956, g4f5: 1957, g4g5: 1958, g4h5: 1959, g4a6: 1960, g4b6: 1961, g4c6: 1962, g4d6: 1963, g4e6: 1964, g4f6: 1965, g4g6: 1966, g4h6: 1967, g4a7: 1968, g4b7: 1969, g4c7: 1970, g4d7: 1971, g4e7: 1972, g4f7: 1973, g4g7: 1974, g4h7: 1975, g4a8: 1976, g4b8: 1977, g4c8: 1978, g4d8: 1979, g4e8: 1980, g4f8: 1981, g4g8: 1982, g4h8: 1983, h4a1: 1984, h4b1: 1985, h4c1: 1986, h4d1: 1987, h4e1: 1988, h4f1: 1989, h4g1: 1990, h4h1: 1991, h4a2: 1992, h4b2: 1993, h4c2: 1994, h4d2: 1995, h4e2: 1996, h4f2: 1997, h4g2: 1998, h4h2: 1999, h4a3: 2e3, h4b3: 2001, h4c3: 2002, h4d3: 2003, h4e3: 2004, h4f3: 2005, h4g3: 2006, h4h3: 2007, h4a4: 2008, h4b4: 2009, h4c4: 2010, h4d4: 2011, h4e4: 2012, h4f4: 2013, h4g4: 2014, h4h4: 2015, h4a5: 2016, h4b5: 2017, h4c5: 2018, h4d5: 2019, h4e5: 2020, h4f5: 2021, h4g5: 2022, h4h5: 2023, h4a6: 2024, h4b6: 2025, h4c6: 2026, h4d6: 2027, h4e6: 2028, h4f6: 2029, h4g6: 2030, h4h6: 2031, h4a7: 2032, h4b7: 2033, h4c7: 2034, h4d7: 2035, h4e7: 2036, h4f7: 2037, h4g7: 2038, h4h7: 2039, h4a8: 2040, h4b8: 2041, h4c8: 2042, h4d8: 2043, h4e8: 2044, h4f8: 2045, h4g8: 2046, h4h8: 2047, a5a1: 2048, a5b1: 2049, a5c1: 2050, a5d1: 2051, a5e1: 2052, a5f1: 2053, a5g1: 2054, a5h1: 2055, a5a2: 2056, a5b2: 2057, a5c2: 2058, a5d2: 2059, a5e2: 2060, a5f2: 2061, a5g2: 2062, a5h2: 2063, a5a3: 2064, a5b3: 2065, a5c3: 2066, a5d3: 2067, a5e3: 2068, a5f3: 2069, a5g3: 2070, a5h3: 2071, a5a4: 2072, a5b4: 2073, a5c4: 2074, a5d4: 2075, a5e4: 2076, a5f4: 2077, a5g4: 2078, a5h4: 2079, a5a5: 2080, a5b5: 2081, a5c5: 2082, a5d5: 2083, a5e5: 2084, a5f5: 2085, a5g5: 2086, a5h5: 2087, a5a6: 2088, a5b6: 2089, a5c6: 2090, a5d6: 2091, a5e6: 2092, a5f6: 2093, a5g6: 2094, a5h6: 2095, a5a7: 2096, a5b7: 2097, a5c7: 2098, a5d7: 2099, a5e7: 2100, a5f7: 2101, a5g7: 2102, a5h7: 2103, a5a8: 2104, a5b8: 2105, a5c8: 2106, a5d8: 2107, a5e8: 2108, a5f8: 2109, a5g8: 2110, a5h8: 2111, b5a1: 2112, b5b1: 2113, b5c1: 2114, b5d1: 2115, b5e1: 2116, b5f1: 2117, b5g1: 2118, b5h1: 2119, b5a2: 2120, b5b2: 2121, b5c2: 2122, b5d2: 2123, b5e2: 2124, b5f2: 2125, b5g2: 2126, b5h2: 2127, b5a3: 2128, b5b3: 2129, b5c3: 2130, b5d3: 2131, b5e3: 2132, b5f3: 2133, b5g3: 2134, b5h3: 2135, b5a4: 2136, b5b4: 2137, b5c4: 2138, b5d4: 2139, b5e4: 2140, b5f4: 2141, b5g4: 2142, b5h4: 2143, b5a5: 2144, b5b5: 2145, b5c5: 2146, b5d5: 2147, b5e5: 2148, b5f5: 2149, b5g5: 2150, b5h5: 2151, b5a6: 2152, b5b6: 2153, b5c6: 2154, b5d6: 2155, b5e6: 2156, b5f6: 2157, b5g6: 2158, b5h6: 2159, b5a7: 2160, b5b7: 2161, b5c7: 2162, b5d7: 2163, b5e7: 2164, b5f7: 2165, b5g7: 2166, b5h7: 2167, b5a8: 2168, b5b8: 2169, b5c8: 2170, b5d8: 2171, b5e8: 2172, b5f8: 2173, b5g8: 2174, b5h8: 2175, c5a1: 2176, c5b1: 2177, c5c1: 2178, c5d1: 2179, c5e1: 2180, c5f1: 2181, c5g1: 2182, c5h1: 2183, c5a2: 2184, c5b2: 2185, c5c2: 2186, c5d2: 2187, c5e2: 2188, c5f2: 2189, c5g2: 2190, c5h2: 2191, c5a3: 2192, c5b3: 2193, c5c3: 2194, c5d3: 2195, c5e3: 2196, c5f3: 2197, c5g3: 2198, c5h3: 2199, c5a4: 2200, c5b4: 2201, c5c4: 2202, c5d4: 2203, c5e4: 2204, c5f4: 2205, c5g4: 2206, c5h4: 2207, c5a5: 2208, c5b5: 2209, c5c5: 2210, c5d5: 2211, c5e5: 2212, c5f5: 2213, c5g5: 2214, c5h5: 2215, c5a6: 2216, c5b6: 2217, c5c6: 2218, c5d6: 2219, c5e6: 2220, c5f6: 2221, c5g6: 2222, c5h6: 2223, c5a7: 2224, c5b7: 2225, c5c7: 2226, c5d7: 2227, c5e7: 2228, c5f7: 2229, c5g7: 2230, c5h7: 2231, c5a8: 2232, c5b8: 2233, c5c8: 2234, c5d8: 2235, c5e8: 2236, c5f8: 2237, c5g8: 2238, c5h8: 2239, d5a1: 2240, d5b1: 2241, d5c1: 2242, d5d1: 2243, d5e1: 2244, d5f1: 2245, d5g1: 2246, d5h1: 2247, d5a2: 2248, d5b2: 2249, d5c2: 2250, d5d2: 2251, d5e2: 2252, d5f2: 2253, d5g2: 2254, d5h2: 2255, d5a3: 2256, d5b3: 2257, d5c3: 2258, d5d3: 2259, d5e3: 2260, d5f3: 2261, d5g3: 2262, d5h3: 2263, d5a4: 2264, d5b4: 2265, d5c4: 2266, d5d4: 2267, d5e4: 2268, d5f4: 2269, d5g4: 2270, d5h4: 2271, d5a5: 2272, d5b5: 2273, d5c5: 2274, d5d5: 2275, d5e5: 2276, d5f5: 2277, d5g5: 2278, d5h5: 2279, d5a6: 2280, d5b6: 2281, d5c6: 2282, d5d6: 2283, d5e6: 2284, d5f6: 2285, d5g6: 2286, d5h6: 2287, d5a7: 2288, d5b7: 2289, d5c7: 2290, d5d7: 2291, d5e7: 2292, d5f7: 2293, d5g7: 2294, d5h7: 2295, d5a8: 2296, d5b8: 2297, d5c8: 2298, d5d8: 2299, d5e8: 2300, d5f8: 2301, d5g8: 2302, d5h8: 2303, e5a1: 2304, e5b1: 2305, e5c1: 2306, e5d1: 2307, e5e1: 2308, e5f1: 2309, e5g1: 2310, e5h1: 2311, e5a2: 2312, e5b2: 2313, e5c2: 2314, e5d2: 2315, e5e2: 2316, e5f2: 2317, e5g2: 2318, e5h2: 2319, e5a3: 2320, e5b3: 2321, e5c3: 2322, e5d3: 2323, e5e3: 2324, e5f3: 2325, e5g3: 2326, e5h3: 2327, e5a4: 2328, e5b4: 2329, e5c4: 2330, e5d4: 2331, e5e4: 2332, e5f4: 2333, e5g4: 2334, e5h4: 2335, e5a5: 2336, e5b5: 2337, e5c5: 2338, e5d5: 2339, e5e5: 2340, e5f5: 2341, e5g5: 2342, e5h5: 2343, e5a6: 2344, e5b6: 2345, e5c6: 2346, e5d6: 2347, e5e6: 2348, e5f6: 2349, e5g6: 2350, e5h6: 2351, e5a7: 2352, e5b7: 2353, e5c7: 2354, e5d7: 2355, e5e7: 2356, e5f7: 2357, e5g7: 2358, e5h7: 2359, e5a8: 2360, e5b8: 2361, e5c8: 2362, e5d8: 2363, e5e8: 2364, e5f8: 2365, e5g8: 2366, e5h8: 2367, f5a1: 2368, f5b1: 2369, f5c1: 2370, f5d1: 2371, f5e1: 2372, f5f1: 2373, f5g1: 2374, f5h1: 2375, f5a2: 2376, f5b2: 2377, f5c2: 2378, f5d2: 2379, f5e2: 2380, f5f2: 2381, f5g2: 2382, f5h2: 2383, f5a3: 2384, f5b3: 2385, f5c3: 2386, f5d3: 2387, f5e3: 2388, f5f3: 2389, f5g3: 2390, f5h3: 2391, f5a4: 2392, f5b4: 2393, f5c4: 2394, f5d4: 2395, f5e4: 2396, f5f4: 2397, f5g4: 2398, f5h4: 2399, f5a5: 2400, f5b5: 2401, f5c5: 2402, f5d5: 2403, f5e5: 2404, f5f5: 2405, f5g5: 2406, f5h5: 2407, f5a6: 2408, f5b6: 2409, f5c6: 2410, f5d6: 2411, f5e6: 2412, f5f6: 2413, f5g6: 2414, f5h6: 2415, f5a7: 2416, f5b7: 2417, f5c7: 2418, f5d7: 2419, f5e7: 2420, f5f7: 2421, f5g7: 2422, f5h7: 2423, f5a8: 2424, f5b8: 2425, f5c8: 2426, f5d8: 2427, f5e8: 2428, f5f8: 2429, f5g8: 2430, f5h8: 2431, g5a1: 2432, g5b1: 2433, g5c1: 2434, g5d1: 2435, g5e1: 2436, g5f1: 2437, g5g1: 2438, g5h1: 2439, g5a2: 2440, g5b2: 2441, g5c2: 2442, g5d2: 2443, g5e2: 2444, g5f2: 2445, g5g2: 2446, g5h2: 2447, g5a3: 2448, g5b3: 2449, g5c3: 2450, g5d3: 2451, g5e3: 2452, g5f3: 2453, g5g3: 2454, g5h3: 2455, g5a4: 2456, g5b4: 2457, g5c4: 2458, g5d4: 2459, g5e4: 2460, g5f4: 2461, g5g4: 2462, g5h4: 2463, g5a5: 2464, g5b5: 2465, g5c5: 2466, g5d5: 2467, g5e5: 2468, g5f5: 2469, g5g5: 2470, g5h5: 2471, g5a6: 2472, g5b6: 2473, g5c6: 2474, g5d6: 2475, g5e6: 2476, g5f6: 2477, g5g6: 2478, g5h6: 2479, g5a7: 2480, g5b7: 2481, g5c7: 2482, g5d7: 2483, g5e7: 2484, g5f7: 2485, g5g7: 2486, g5h7: 2487, g5a8: 2488, g5b8: 2489, g5c8: 2490, g5d8: 2491, g5e8: 2492, g5f8: 2493, g5g8: 2494, g5h8: 2495, h5a1: 2496, h5b1: 2497, h5c1: 2498, h5d1: 2499, h5e1: 2500, h5f1: 2501, h5g1: 2502, h5h1: 2503, h5a2: 2504, h5b2: 2505, h5c2: 2506, h5d2: 2507, h5e2: 2508, h5f2: 2509, h5g2: 2510, h5h2: 2511, h5a3: 2512, h5b3: 2513, h5c3: 2514, h5d3: 2515, h5e3: 2516, h5f3: 2517, h5g3: 2518, h5h3: 2519, h5a4: 2520, h5b4: 2521, h5c4: 2522, h5d4: 2523, h5e4: 2524, h5f4: 2525, h5g4: 2526, h5h4: 2527, h5a5: 2528, h5b5: 2529, h5c5: 2530, h5d5: 2531, h5e5: 2532, h5f5: 2533, h5g5: 2534, h5h5: 2535, h5a6: 2536, h5b6: 2537, h5c6: 2538, h5d6: 2539, h5e6: 2540, h5f6: 2541, h5g6: 2542, h5h6: 2543, h5a7: 2544, h5b7: 2545, h5c7: 2546, h5d7: 2547, h5e7: 2548, h5f7: 2549, h5g7: 2550, h5h7: 2551, h5a8: 2552, h5b8: 2553, h5c8: 2554, h5d8: 2555, h5e8: 2556, h5f8: 2557, h5g8: 2558, h5h8: 2559, a6a1: 2560, a6b1: 2561, a6c1: 2562, a6d1: 2563, a6e1: 2564, a6f1: 2565, a6g1: 2566, a6h1: 2567, a6a2: 2568, a6b2: 2569, a6c2: 2570, a6d2: 2571, a6e2: 2572, a6f2: 2573, a6g2: 2574, a6h2: 2575, a6a3: 2576, a6b3: 2577, a6c3: 2578, a6d3: 2579, a6e3: 2580, a6f3: 2581, a6g3: 2582, a6h3: 2583, a6a4: 2584, a6b4: 2585, a6c4: 2586, a6d4: 2587, a6e4: 2588, a6f4: 2589, a6g4: 2590, a6h4: 2591, a6a5: 2592, a6b5: 2593, a6c5: 2594, a6d5: 2595, a6e5: 2596, a6f5: 2597, a6g5: 2598, a6h5: 2599, a6a6: 2600, a6b6: 2601, a6c6: 2602, a6d6: 2603, a6e6: 2604, a6f6: 2605, a6g6: 2606, a6h6: 2607, a6a7: 2608, a6b7: 2609, a6c7: 2610, a6d7: 2611, a6e7: 2612, a6f7: 2613, a6g7: 2614, a6h7: 2615, a6a8: 2616, a6b8: 2617, a6c8: 2618, a6d8: 2619, a6e8: 2620, a6f8: 2621, a6g8: 2622, a6h8: 2623, b6a1: 2624, b6b1: 2625, b6c1: 2626, b6d1: 2627, b6e1: 2628, b6f1: 2629, b6g1: 2630, b6h1: 2631, b6a2: 2632, b6b2: 2633, b6c2: 2634, b6d2: 2635, b6e2: 2636, b6f2: 2637, b6g2: 2638, b6h2: 2639, b6a3: 2640, b6b3: 2641, b6c3: 2642, b6d3: 2643, b6e3: 2644, b6f3: 2645, b6g3: 2646, b6h3: 2647, b6a4: 2648, b6b4: 2649, b6c4: 2650, b6d4: 2651, b6e4: 2652, b6f4: 2653, b6g4: 2654, b6h4: 2655, b6a5: 2656, b6b5: 2657, b6c5: 2658, b6d5: 2659, b6e5: 2660, b6f5: 2661, b6g5: 2662, b6h5: 2663, b6a6: 2664, b6b6: 2665, b6c6: 2666, b6d6: 2667, b6e6: 2668, b6f6: 2669, b6g6: 2670, b6h6: 2671, b6a7: 2672, b6b7: 2673, b6c7: 2674, b6d7: 2675, b6e7: 2676, b6f7: 2677, b6g7: 2678, b6h7: 2679, b6a8: 2680, b6b8: 2681, b6c8: 2682, b6d8: 2683, b6e8: 2684, b6f8: 2685, b6g8: 2686, b6h8: 2687, c6a1: 2688, c6b1: 2689, c6c1: 2690, c6d1: 2691, c6e1: 2692, c6f1: 2693, c6g1: 2694, c6h1: 2695, c6a2: 2696, c6b2: 2697, c6c2: 2698, c6d2: 2699, c6e2: 2700, c6f2: 2701, c6g2: 2702, c6h2: 2703, c6a3: 2704, c6b3: 2705, c6c3: 2706, c6d3: 2707, c6e3: 2708, c6f3: 2709, c6g3: 2710, c6h3: 2711, c6a4: 2712, c6b4: 2713, c6c4: 2714, c6d4: 2715, c6e4: 2716, c6f4: 2717, c6g4: 2718, c6h4: 2719, c6a5: 2720, c6b5: 2721, c6c5: 2722, c6d5: 2723, c6e5: 2724, c6f5: 2725, c6g5: 2726, c6h5: 2727, c6a6: 2728, c6b6: 2729, c6c6: 2730, c6d6: 2731, c6e6: 2732, c6f6: 2733, c6g6: 2734, c6h6: 2735, c6a7: 2736, c6b7: 2737, c6c7: 2738, c6d7: 2739, c6e7: 2740, c6f7: 2741, c6g7: 2742, c6h7: 2743, c6a8: 2744, c6b8: 2745, c6c8: 2746, c6d8: 2747, c6e8: 2748, c6f8: 2749, c6g8: 2750, c6h8: 2751, d6a1: 2752, d6b1: 2753, d6c1: 2754, d6d1: 2755, d6e1: 2756, d6f1: 2757, d6g1: 2758, d6h1: 2759, d6a2: 2760, d6b2: 2761, d6c2: 2762, d6d2: 2763, d6e2: 2764, d6f2: 2765, d6g2: 2766, d6h2: 2767, d6a3: 2768, d6b3: 2769, d6c3: 2770, d6d3: 2771, d6e3: 2772, d6f3: 2773, d6g3: 2774, d6h3: 2775, d6a4: 2776, d6b4: 2777, d6c4: 2778, d6d4: 2779, d6e4: 2780, d6f4: 2781, d6g4: 2782, d6h4: 2783, d6a5: 2784, d6b5: 2785, d6c5: 2786, d6d5: 2787, d6e5: 2788, d6f5: 2789, d6g5: 2790, d6h5: 2791, d6a6: 2792, d6b6: 2793, d6c6: 2794, d6d6: 2795, d6e6: 2796, d6f6: 2797, d6g6: 2798, d6h6: 2799, d6a7: 2800, d6b7: 2801, d6c7: 2802, d6d7: 2803, d6e7: 2804, d6f7: 2805, d6g7: 2806, d6h7: 2807, d6a8: 2808, d6b8: 2809, d6c8: 2810, d6d8: 2811, d6e8: 2812, d6f8: 2813, d6g8: 2814, d6h8: 2815, e6a1: 2816, e6b1: 2817, e6c1: 2818, e6d1: 2819, e6e1: 2820, e6f1: 2821, e6g1: 2822, e6h1: 2823, e6a2: 2824, e6b2: 2825, e6c2: 2826, e6d2: 2827, e6e2: 2828, e6f2: 2829, e6g2: 2830, e6h2: 2831, e6a3: 2832, e6b3: 2833, e6c3: 2834, e6d3: 2835, e6e3: 2836, e6f3: 2837, e6g3: 2838, e6h3: 2839, e6a4: 2840, e6b4: 2841, e6c4: 2842, e6d4: 2843, e6e4: 2844, e6f4: 2845, e6g4: 2846, e6h4: 2847, e6a5: 2848, e6b5: 2849, e6c5: 2850, e6d5: 2851, e6e5: 2852, e6f5: 2853, e6g5: 2854, e6h5: 2855, e6a6: 2856, e6b6: 2857, e6c6: 2858, e6d6: 2859, e6e6: 2860, e6f6: 2861, e6g6: 2862, e6h6: 2863, e6a7: 2864, e6b7: 2865, e6c7: 2866, e6d7: 2867, e6e7: 2868, e6f7: 2869, e6g7: 2870, e6h7: 2871, e6a8: 2872, e6b8: 2873, e6c8: 2874, e6d8: 2875, e6e8: 2876, e6f8: 2877, e6g8: 2878, e6h8: 2879, f6a1: 2880, f6b1: 2881, f6c1: 2882, f6d1: 2883, f6e1: 2884, f6f1: 2885, f6g1: 2886, f6h1: 2887, f6a2: 2888, f6b2: 2889, f6c2: 2890, f6d2: 2891, f6e2: 2892, f6f2: 2893, f6g2: 2894, f6h2: 2895, f6a3: 2896, f6b3: 2897, f6c3: 2898, f6d3: 2899, f6e3: 2900, f6f3: 2901, f6g3: 2902, f6h3: 2903, f6a4: 2904, f6b4: 2905, f6c4: 2906, f6d4: 2907, f6e4: 2908, f6f4: 2909, f6g4: 2910, f6h4: 2911, f6a5: 2912, f6b5: 2913, f6c5: 2914, f6d5: 2915, f6e5: 2916, f6f5: 2917, f6g5: 2918, f6h5: 2919, f6a6: 2920, f6b6: 2921, f6c6: 2922, f6d6: 2923, f6e6: 2924, f6f6: 2925, f6g6: 2926, f6h6: 2927, f6a7: 2928, f6b7: 2929, f6c7: 2930, f6d7: 2931, f6e7: 2932, f6f7: 2933, f6g7: 2934, f6h7: 2935, f6a8: 2936, f6b8: 2937, f6c8: 2938, f6d8: 2939, f6e8: 2940, f6f8: 2941, f6g8: 2942, f6h8: 2943, g6a1: 2944, g6b1: 2945, g6c1: 2946, g6d1: 2947, g6e1: 2948, g6f1: 2949, g6g1: 2950, g6h1: 2951, g6a2: 2952, g6b2: 2953, g6c2: 2954, g6d2: 2955, g6e2: 2956, g6f2: 2957, g6g2: 2958, g6h2: 2959, g6a3: 2960, g6b3: 2961, g6c3: 2962, g6d3: 2963, g6e3: 2964, g6f3: 2965, g6g3: 2966, g6h3: 2967, g6a4: 2968, g6b4: 2969, g6c4: 2970, g6d4: 2971, g6e4: 2972, g6f4: 2973, g6g4: 2974, g6h4: 2975, g6a5: 2976, g6b5: 2977, g6c5: 2978, g6d5: 2979, g6e5: 2980, g6f5: 2981, g6g5: 2982, g6h5: 2983, g6a6: 2984, g6b6: 2985, g6c6: 2986, g6d6: 2987, g6e6: 2988, g6f6: 2989, g6g6: 2990, g6h6: 2991, g6a7: 2992, g6b7: 2993, g6c7: 2994, g6d7: 2995, g6e7: 2996, g6f7: 2997, g6g7: 2998, g6h7: 2999, g6a8: 3e3, g6b8: 3001, g6c8: 3002, g6d8: 3003, g6e8: 3004, g6f8: 3005, g6g8: 3006, g6h8: 3007, h6a1: 3008, h6b1: 3009, h6c1: 3010, h6d1: 3011, h6e1: 3012, h6f1: 3013, h6g1: 3014, h6h1: 3015, h6a2: 3016, h6b2: 3017, h6c2: 3018, h6d2: 3019, h6e2: 3020, h6f2: 3021, h6g2: 3022, h6h2: 3023, h6a3: 3024, h6b3: 3025, h6c3: 3026, h6d3: 3027, h6e3: 3028, h6f3: 3029, h6g3: 3030, h6h3: 3031, h6a4: 3032, h6b4: 3033, h6c4: 3034, h6d4: 3035, h6e4: 3036, h6f4: 3037, h6g4: 3038, h6h4: 3039, h6a5: 3040, h6b5: 3041, h6c5: 3042, h6d5: 3043, h6e5: 3044, h6f5: 3045, h6g5: 3046, h6h5: 3047, h6a6: 3048, h6b6: 3049, h6c6: 3050, h6d6: 3051, h6e6: 3052, h6f6: 3053, h6g6: 3054, h6h6: 3055, h6a7: 3056, h6b7: 3057, h6c7: 3058, h6d7: 3059, h6e7: 3060, h6f7: 3061, h6g7: 3062, h6h7: 3063, h6a8: 3064, h6b8: 3065, h6c8: 3066, h6d8: 3067, h6e8: 3068, h6f8: 3069, h6g8: 3070, h6h8: 3071, a7a1: 3072, a7b1: 3073, a7c1: 3074, a7d1: 3075, a7e1: 3076, a7f1: 3077, a7g1: 3078, a7h1: 3079, a7a2: 3080, a7b2: 3081, a7c2: 3082, a7d2: 3083, a7e2: 3084, a7f2: 3085, a7g2: 3086, a7h2: 3087, a7a3: 3088, a7b3: 3089, a7c3: 3090, a7d3: 3091, a7e3: 3092, a7f3: 3093, a7g3: 3094, a7h3: 3095, a7a4: 3096, a7b4: 3097, a7c4: 3098, a7d4: 3099, a7e4: 3100, a7f4: 3101, a7g4: 3102, a7h4: 3103, a7a5: 3104, a7b5: 3105, a7c5: 3106, a7d5: 3107, a7e5: 3108, a7f5: 3109, a7g5: 3110, a7h5: 3111, a7a6: 3112, a7b6: 3113, a7c6: 3114, a7d6: 3115, a7e6: 3116, a7f6: 3117, a7g6: 3118, a7h6: 3119, a7a7: 3120, a7b7: 3121, a7c7: 3122, a7d7: 3123, a7e7: 3124, a7f7: 3125, a7g7: 3126, a7h7: 3127, a7a8: 3128, a7b8: 3129, a7c8: 3130, a7d8: 3131, a7e8: 3132, a7f8: 3133, a7g8: 3134, a7h8: 3135, b7a1: 3136, b7b1: 3137, b7c1: 3138, b7d1: 3139, b7e1: 3140, b7f1: 3141, b7g1: 3142, b7h1: 3143, b7a2: 3144, b7b2: 3145, b7c2: 3146, b7d2: 3147, b7e2: 3148, b7f2: 3149, b7g2: 3150, b7h2: 3151, b7a3: 3152, b7b3: 3153, b7c3: 3154, b7d3: 3155, b7e3: 3156, b7f3: 3157, b7g3: 3158, b7h3: 3159, b7a4: 3160, b7b4: 3161, b7c4: 3162, b7d4: 3163, b7e4: 3164, b7f4: 3165, b7g4: 3166, b7h4: 3167, b7a5: 3168, b7b5: 3169, b7c5: 3170, b7d5: 3171, b7e5: 3172, b7f5: 3173, b7g5: 3174, b7h5: 3175, b7a6: 3176, b7b6: 3177, b7c6: 3178, b7d6: 3179, b7e6: 3180, b7f6: 3181, b7g6: 3182, b7h6: 3183, b7a7: 3184, b7b7: 3185, b7c7: 3186, b7d7: 3187, b7e7: 3188, b7f7: 3189, b7g7: 3190, b7h7: 3191, b7a8: 3192, b7b8: 3193, b7c8: 3194, b7d8: 3195, b7e8: 3196, b7f8: 3197, b7g8: 3198, b7h8: 3199, c7a1: 3200, c7b1: 3201, c7c1: 3202, c7d1: 3203, c7e1: 3204, c7f1: 3205, c7g1: 3206, c7h1: 3207, c7a2: 3208, c7b2: 3209, c7c2: 3210, c7d2: 3211, c7e2: 3212, c7f2: 3213, c7g2: 3214, c7h2: 3215, c7a3: 3216, c7b3: 3217, c7c3: 3218, c7d3: 3219, c7e3: 3220, c7f3: 3221, c7g3: 3222, c7h3: 3223, c7a4: 3224, c7b4: 3225, c7c4: 3226, c7d4: 3227, c7e4: 3228, c7f4: 3229, c7g4: 3230, c7h4: 3231, c7a5: 3232, c7b5: 3233, c7c5: 3234, c7d5: 3235, c7e5: 3236, c7f5: 3237, c7g5: 3238, c7h5: 3239, c7a6: 3240, c7b6: 3241, c7c6: 3242, c7d6: 3243, c7e6: 3244, c7f6: 3245, c7g6: 3246, c7h6: 3247, c7a7: 3248, c7b7: 3249, c7c7: 3250, c7d7: 3251, c7e7: 3252, c7f7: 3253, c7g7: 3254, c7h7: 3255, c7a8: 3256, c7b8: 3257, c7c8: 3258, c7d8: 3259, c7e8: 3260, c7f8: 3261, c7g8: 3262, c7h8: 3263, d7a1: 3264, d7b1: 3265, d7c1: 3266, d7d1: 3267, d7e1: 3268, d7f1: 3269, d7g1: 3270, d7h1: 3271, d7a2: 3272, d7b2: 3273, d7c2: 3274, d7d2: 3275, d7e2: 3276, d7f2: 3277, d7g2: 3278, d7h2: 3279, d7a3: 3280, d7b3: 3281, d7c3: 3282, d7d3: 3283, d7e3: 3284, d7f3: 3285, d7g3: 3286, d7h3: 3287, d7a4: 3288, d7b4: 3289, d7c4: 3290, d7d4: 3291, d7e4: 3292, d7f4: 3293, d7g4: 3294, d7h4: 3295, d7a5: 3296, d7b5: 3297, d7c5: 3298, d7d5: 3299, d7e5: 3300, d7f5: 3301, d7g5: 3302, d7h5: 3303, d7a6: 3304, d7b6: 3305, d7c6: 3306, d7d6: 3307, d7e6: 3308, d7f6: 3309, d7g6: 3310, d7h6: 3311, d7a7: 3312, d7b7: 3313, d7c7: 3314, d7d7: 3315, d7e7: 3316, d7f7: 3317, d7g7: 3318, d7h7: 3319, d7a8: 3320, d7b8: 3321, d7c8: 3322, d7d8: 3323, d7e8: 3324, d7f8: 3325, d7g8: 3326, d7h8: 3327, e7a1: 3328, e7b1: 3329, e7c1: 3330, e7d1: 3331, e7e1: 3332, e7f1: 3333, e7g1: 3334, e7h1: 3335, e7a2: 3336, e7b2: 3337, e7c2: 3338, e7d2: 3339, e7e2: 3340, e7f2: 3341, e7g2: 3342, e7h2: 3343, e7a3: 3344, e7b3: 3345, e7c3: 3346, e7d3: 3347, e7e3: 3348, e7f3: 3349, e7g3: 3350, e7h3: 3351, e7a4: 3352, e7b4: 3353, e7c4: 3354, e7d4: 3355, e7e4: 3356, e7f4: 3357, e7g4: 3358, e7h4: 3359, e7a5: 3360, e7b5: 3361, e7c5: 3362, e7d5: 3363, e7e5: 3364, e7f5: 3365, e7g5: 3366, e7h5: 3367, e7a6: 3368, e7b6: 3369, e7c6: 3370, e7d6: 3371, e7e6: 3372, e7f6: 3373, e7g6: 3374, e7h6: 3375, e7a7: 3376, e7b7: 3377, e7c7: 3378, e7d7: 3379, e7e7: 3380, e7f7: 3381, e7g7: 3382, e7h7: 3383, e7a8: 3384, e7b8: 3385, e7c8: 3386, e7d8: 3387, e7e8: 3388, e7f8: 3389, e7g8: 3390, e7h8: 3391, f7a1: 3392, f7b1: 3393, f7c1: 3394, f7d1: 3395, f7e1: 3396, f7f1: 3397, f7g1: 3398, f7h1: 3399, f7a2: 3400, f7b2: 3401, f7c2: 3402, f7d2: 3403, f7e2: 3404, f7f2: 3405, f7g2: 3406, f7h2: 3407, f7a3: 3408, f7b3: 3409, f7c3: 3410, f7d3: 3411, f7e3: 3412, f7f3: 3413, f7g3: 3414, f7h3: 3415, f7a4: 3416, f7b4: 3417, f7c4: 3418, f7d4: 3419, f7e4: 3420, f7f4: 3421, f7g4: 3422, f7h4: 3423, f7a5: 3424, f7b5: 3425, f7c5: 3426, f7d5: 3427, f7e5: 3428, f7f5: 3429, f7g5: 3430, f7h5: 3431, f7a6: 3432, f7b6: 3433, f7c6: 3434, f7d6: 3435, f7e6: 3436, f7f6: 3437, f7g6: 3438, f7h6: 3439, f7a7: 3440, f7b7: 3441, f7c7: 3442, f7d7: 3443, f7e7: 3444, f7f7: 3445, f7g7: 3446, f7h7: 3447, f7a8: 3448, f7b8: 3449, f7c8: 3450, f7d8: 3451, f7e8: 3452, f7f8: 3453, f7g8: 3454, f7h8: 3455, g7a1: 3456, g7b1: 3457, g7c1: 3458, g7d1: 3459, g7e1: 3460, g7f1: 3461, g7g1: 3462, g7h1: 3463, g7a2: 3464, g7b2: 3465, g7c2: 3466, g7d2: 3467, g7e2: 3468, g7f2: 3469, g7g2: 3470, g7h2: 3471, g7a3: 3472, g7b3: 3473, g7c3: 3474, g7d3: 3475, g7e3: 3476, g7f3: 3477, g7g3: 3478, g7h3: 3479, g7a4: 3480, g7b4: 3481, g7c4: 3482, g7d4: 3483, g7e4: 3484, g7f4: 3485, g7g4: 3486, g7h4: 3487, g7a5: 3488, g7b5: 3489, g7c5: 3490, g7d5: 3491, g7e5: 3492, g7f5: 3493, g7g5: 3494, g7h5: 3495, g7a6: 3496, g7b6: 3497, g7c6: 3498, g7d6: 3499, g7e6: 3500, g7f6: 3501, g7g6: 3502, g7h6: 3503, g7a7: 3504, g7b7: 3505, g7c7: 3506, g7d7: 3507, g7e7: 3508, g7f7: 3509, g7g7: 3510, g7h7: 3511, g7a8: 3512, g7b8: 3513, g7c8: 3514, g7d8: 3515, g7e8: 3516, g7f8: 3517, g7g8: 3518, g7h8: 3519, h7a1: 3520, h7b1: 3521, h7c1: 3522, h7d1: 3523, h7e1: 3524, h7f1: 3525, h7g1: 3526, h7h1: 3527, h7a2: 3528, h7b2: 3529, h7c2: 3530, h7d2: 3531, h7e2: 3532, h7f2: 3533, h7g2: 3534, h7h2: 3535, h7a3: 3536, h7b3: 3537, h7c3: 3538, h7d3: 3539, h7e3: 3540, h7f3: 3541, h7g3: 3542, h7h3: 3543, h7a4: 3544, h7b4: 3545, h7c4: 3546, h7d4: 3547, h7e4: 3548, h7f4: 3549, h7g4: 3550, h7h4: 3551, h7a5: 3552, h7b5: 3553, h7c5: 3554, h7d5: 3555, h7e5: 3556, h7f5: 3557, h7g5: 3558, h7h5: 3559, h7a6: 3560, h7b6: 3561, h7c6: 3562, h7d6: 3563, h7e6: 3564, h7f6: 3565, h7g6: 3566, h7h6: 3567, h7a7: 3568, h7b7: 3569, h7c7: 3570, h7d7: 3571, h7e7: 3572, h7f7: 3573, h7g7: 3574, h7h7: 3575, h7a8: 3576, h7b8: 3577, h7c8: 3578, h7d8: 3579, h7e8: 3580, h7f8: 3581, h7g8: 3582, h7h8: 3583, a8a1: 3584, a8b1: 3585, a8c1: 3586, a8d1: 3587, a8e1: 3588, a8f1: 3589, a8g1: 3590, a8h1: 3591, a8a2: 3592, a8b2: 3593, a8c2: 3594, a8d2: 3595, a8e2: 3596, a8f2: 3597, a8g2: 3598, a8h2: 3599, a8a3: 3600, a8b3: 3601, a8c3: 3602, a8d3: 3603, a8e3: 3604, a8f3: 3605, a8g3: 3606, a8h3: 3607, a8a4: 3608, a8b4: 3609, a8c4: 3610, a8d4: 3611, a8e4: 3612, a8f4: 3613, a8g4: 3614, a8h4: 3615, a8a5: 3616, a8b5: 3617, a8c5: 3618, a8d5: 3619, a8e5: 3620, a8f5: 3621, a8g5: 3622, a8h5: 3623, a8a6: 3624, a8b6: 3625, a8c6: 3626, a8d6: 3627, a8e6: 3628, a8f6: 3629, a8g6: 3630, a8h6: 3631, a8a7: 3632, a8b7: 3633, a8c7: 3634, a8d7: 3635, a8e7: 3636, a8f7: 3637, a8g7: 3638, a8h7: 3639, a8a8: 3640, a8b8: 3641, a8c8: 3642, a8d8: 3643, a8e8: 3644, a8f8: 3645, a8g8: 3646, a8h8: 3647, b8a1: 3648, b8b1: 3649, b8c1: 3650, b8d1: 3651, b8e1: 3652, b8f1: 3653, b8g1: 3654, b8h1: 3655, b8a2: 3656, b8b2: 3657, b8c2: 3658, b8d2: 3659, b8e2: 3660, b8f2: 3661, b8g2: 3662, b8h2: 3663, b8a3: 3664, b8b3: 3665, b8c3: 3666, b8d3: 3667, b8e3: 3668, b8f3: 3669, b8g3: 3670, b8h3: 3671, b8a4: 3672, b8b4: 3673, b8c4: 3674, b8d4: 3675, b8e4: 3676, b8f4: 3677, b8g4: 3678, b8h4: 3679, b8a5: 3680, b8b5: 3681, b8c5: 3682, b8d5: 3683, b8e5: 3684, b8f5: 3685, b8g5: 3686, b8h5: 3687, b8a6: 3688, b8b6: 3689, b8c6: 3690, b8d6: 3691, b8e6: 3692, b8f6: 3693, b8g6: 3694, b8h6: 3695, b8a7: 3696, b8b7: 3697, b8c7: 3698, b8d7: 3699, b8e7: 3700, b8f7: 3701, b8g7: 3702, b8h7: 3703, b8a8: 3704, b8b8: 3705, b8c8: 3706, b8d8: 3707, b8e8: 3708, b8f8: 3709, b8g8: 3710, b8h8: 3711, c8a1: 3712, c8b1: 3713, c8c1: 3714, c8d1: 3715, c8e1: 3716, c8f1: 3717, c8g1: 3718, c8h1: 3719, c8a2: 3720, c8b2: 3721, c8c2: 3722, c8d2: 3723, c8e2: 3724, c8f2: 3725, c8g2: 3726, c8h2: 3727, c8a3: 3728, c8b3: 3729, c8c3: 3730, c8d3: 3731, c8e3: 3732, c8f3: 3733, c8g3: 3734, c8h3: 3735, c8a4: 3736, c8b4: 3737, c8c4: 3738, c8d4: 3739, c8e4: 3740, c8f4: 3741, c8g4: 3742, c8h4: 3743, c8a5: 3744, c8b5: 3745, c8c5: 3746, c8d5: 3747, c8e5: 3748, c8f5: 3749, c8g5: 3750, c8h5: 3751, c8a6: 3752, c8b6: 3753, c8c6: 3754, c8d6: 3755, c8e6: 3756, c8f6: 3757, c8g6: 3758, c8h6: 3759, c8a7: 3760, c8b7: 3761, c8c7: 3762, c8d7: 3763, c8e7: 3764, c8f7: 3765, c8g7: 3766, c8h7: 3767, c8a8: 3768, c8b8: 3769, c8c8: 3770, c8d8: 3771, c8e8: 3772, c8f8: 3773, c8g8: 3774, c8h8: 3775, d8a1: 3776, d8b1: 3777, d8c1: 3778, d8d1: 3779, d8e1: 3780, d8f1: 3781, d8g1: 3782, d8h1: 3783, d8a2: 3784, d8b2: 3785, d8c2: 3786, d8d2: 3787, d8e2: 3788, d8f2: 3789, d8g2: 3790, d8h2: 3791, d8a3: 3792, d8b3: 3793, d8c3: 3794, d8d3: 3795, d8e3: 3796, d8f3: 3797, d8g3: 3798, d8h3: 3799, d8a4: 3800, d8b4: 3801, d8c4: 3802, d8d4: 3803, d8e4: 3804, d8f4: 3805, d8g4: 3806, d8h4: 3807, d8a5: 3808, d8b5: 3809, d8c5: 3810, d8d5: 3811, d8e5: 3812, d8f5: 3813, d8g5: 3814, d8h5: 3815, d8a6: 3816, d8b6: 3817, d8c6: 3818, d8d6: 3819, d8e6: 3820, d8f6: 3821, d8g6: 3822, d8h6: 3823, d8a7: 3824, d8b7: 3825, d8c7: 3826, d8d7: 3827, d8e7: 3828, d8f7: 3829, d8g7: 3830, d8h7: 3831, d8a8: 3832, d8b8: 3833, d8c8: 3834, d8d8: 3835, d8e8: 3836, d8f8: 3837, d8g8: 3838, d8h8: 3839, e8a1: 3840, e8b1: 3841, e8c1: 3842, e8d1: 3843, e8e1: 3844, e8f1: 3845, e8g1: 3846, e8h1: 3847, e8a2: 3848, e8b2: 3849, e8c2: 3850, e8d2: 3851, e8e2: 3852, e8f2: 3853, e8g2: 3854, e8h2: 3855, e8a3: 3856, e8b3: 3857, e8c3: 3858, e8d3: 3859, e8e3: 3860, e8f3: 3861, e8g3: 3862, e8h3: 3863, e8a4: 3864, e8b4: 3865, e8c4: 3866, e8d4: 3867, e8e4: 3868, e8f4: 3869, e8g4: 3870, e8h4: 3871, e8a5: 3872, e8b5: 3873, e8c5: 3874, e8d5: 3875, e8e5: 3876, e8f5: 3877, e8g5: 3878, e8h5: 3879, e8a6: 3880, e8b6: 3881, e8c6: 3882, e8d6: 3883, e8e6: 3884, e8f6: 3885, e8g6: 3886, e8h6: 3887, e8a7: 3888, e8b7: 3889, e8c7: 3890, e8d7: 3891, e8e7: 3892, e8f7: 3893, e8g7: 3894, e8h7: 3895, e8a8: 3896, e8b8: 3897, e8c8: 3898, e8d8: 3899, e8e8: 3900, e8f8: 3901, e8g8: 3902, e8h8: 3903, f8a1: 3904, f8b1: 3905, f8c1: 3906, f8d1: 3907, f8e1: 3908, f8f1: 3909, f8g1: 3910, f8h1: 3911, f8a2: 3912, f8b2: 3913, f8c2: 3914, f8d2: 3915, f8e2: 3916, f8f2: 3917, f8g2: 3918, f8h2: 3919, f8a3: 3920, f8b3: 3921, f8c3: 3922, f8d3: 3923, f8e3: 3924, f8f3: 3925, f8g3: 3926, f8h3: 3927, f8a4: 3928, f8b4: 3929, f8c4: 3930, f8d4: 3931, f8e4: 3932, f8f4: 3933, f8g4: 3934, f8h4: 3935, f8a5: 3936, f8b5: 3937, f8c5: 3938, f8d5: 3939, f8e5: 3940, f8f5: 3941, f8g5: 3942, f8h5: 3943, f8a6: 3944, f8b6: 3945, f8c6: 3946, f8d6: 3947, f8e6: 3948, f8f6: 3949, f8g6: 3950, f8h6: 3951, f8a7: 3952, f8b7: 3953, f8c7: 3954, f8d7: 3955, f8e7: 3956, f8f7: 3957, f8g7: 3958, f8h7: 3959, f8a8: 3960, f8b8: 3961, f8c8: 3962, f8d8: 3963, f8e8: 3964, f8f8: 3965, f8g8: 3966, f8h8: 3967, g8a1: 3968, g8b1: 3969, g8c1: 3970, g8d1: 3971, g8e1: 3972, g8f1: 3973, g8g1: 3974, g8h1: 3975, g8a2: 3976, g8b2: 3977, g8c2: 3978, g8d2: 3979, g8e2: 3980, g8f2: 3981, g8g2: 3982, g8h2: 3983, g8a3: 3984, g8b3: 3985, g8c3: 3986, g8d3: 3987, g8e3: 3988, g8f3: 3989, g8g3: 3990, g8h3: 3991, g8a4: 3992, g8b4: 3993, g8c4: 3994, g8d4: 3995, g8e4: 3996, g8f4: 3997, g8g4: 3998, g8h4: 3999, g8a5: 4e3, g8b5: 4001, g8c5: 4002, g8d5: 4003, g8e5: 4004, g8f5: 4005, g8g5: 4006, g8h5: 4007, g8a6: 4008, g8b6: 4009, g8c6: 4010, g8d6: 4011, g8e6: 4012, g8f6: 4013, g8g6: 4014, g8h6: 4015, g8a7: 4016, g8b7: 4017, g8c7: 4018, g8d7: 4019, g8e7: 4020, g8f7: 4021, g8g7: 4022, g8h7: 4023, g8a8: 4024, g8b8: 4025, g8c8: 4026, g8d8: 4027, g8e8: 4028, g8f8: 4029, g8g8: 4030, g8h8: 4031, h8a1: 4032, h8b1: 4033, h8c1: 4034, h8d1: 4035, h8e1: 4036, h8f1: 4037, h8g1: 4038, h8h1: 4039, h8a2: 4040, h8b2: 4041, h8c2: 4042, h8d2: 4043, h8e2: 4044, h8f2: 4045, h8g2: 4046, h8h2: 4047, h8a3: 4048, h8b3: 4049, h8c3: 4050, h8d3: 4051, h8e3: 4052, h8f3: 4053, h8g3: 4054, h8h3: 4055, h8a4: 4056, h8b4: 4057, h8c4: 4058, h8d4: 4059, h8e4: 4060, h8f4: 4061, h8g4: 4062, h8h4: 4063, h8a5: 4064, h8b5: 4065, h8c5: 4066, h8d5: 4067, h8e5: 4068, h8f5: 4069, h8g5: 4070, h8h5: 4071, h8a6: 4072, h8b6: 4073, h8c6: 4074, h8d6: 4075, h8e6: 4076, h8f6: 4077, h8g6: 4078, h8h6: 4079, h8a7: 4080, h8b7: 4081, h8c7: 4082, h8d7: 4083, h8e7: 4084, h8f7: 4085, h8g7: 4086, h8h7: 4087, h8a8: 4088, h8b8: 4089, h8c8: 4090, h8d8: 4091, h8e8: 4092, h8f8: 4093, h8g8: 4094, h8h8: 4095, a7a8q: 4096, a7a8r: 4097, a7a8b: 4098, a7a8n: 4099, a7b8q: 4100, a7b8r: 4101, a7b8b: 4102, a7b8n: 4103, a7c8q: 4104, a7c8r: 4105, a7c8b: 4106, a7c8n: 4107, a7d8q: 4108, a7d8r: 4109, a7d8b: 4110, a7d8n: 4111, a7e8q: 4112, a7e8r: 4113, a7e8b: 4114, a7e8n: 4115, a7f8q: 4116, a7f8r: 4117, a7f8b: 4118, a7f8n: 4119, a7g8q: 4120, a7g8r: 4121, a7g8b: 4122, a7g8n: 4123, a7h8q: 4124, a7h8r: 4125, a7h8b: 4126, a7h8n: 4127, b7a8q: 4128, b7a8r: 4129, b7a8b: 4130, b7a8n: 4131, b7b8q: 4132, b7b8r: 4133, b7b8b: 4134, b7b8n: 4135, b7c8q: 4136, b7c8r: 4137, b7c8b: 4138, b7c8n: 4139, b7d8q: 4140, b7d8r: 4141, b7d8b: 4142, b7d8n: 4143, b7e8q: 4144, b7e8r: 4145, b7e8b: 4146, b7e8n: 4147, b7f8q: 4148, b7f8r: 4149, b7f8b: 4150, b7f8n: 4151, b7g8q: 4152, b7g8r: 4153, b7g8b: 4154, b7g8n: 4155, b7h8q: 4156, b7h8r: 4157, b7h8b: 4158, b7h8n: 4159, c7a8q: 4160, c7a8r: 4161, c7a8b: 4162, c7a8n: 4163, c7b8q: 4164, c7b8r: 4165, c7b8b: 4166, c7b8n: 4167, c7c8q: 4168, c7c8r: 4169, c7c8b: 4170, c7c8n: 4171, c7d8q: 4172, c7d8r: 4173, c7d8b: 4174, c7d8n: 4175, c7e8q: 4176, c7e8r: 4177, c7e8b: 4178, c7e8n: 4179, c7f8q: 4180, c7f8r: 4181, c7f8b: 4182, c7f8n: 4183, c7g8q: 4184, c7g8r: 4185, c7g8b: 4186, c7g8n: 4187, c7h8q: 4188, c7h8r: 4189, c7h8b: 4190, c7h8n: 4191, d7a8q: 4192, d7a8r: 4193, d7a8b: 4194, d7a8n: 4195, d7b8q: 4196, d7b8r: 4197, d7b8b: 4198, d7b8n: 4199, d7c8q: 4200, d7c8r: 4201, d7c8b: 4202, d7c8n: 4203, d7d8q: 4204, d7d8r: 4205, d7d8b: 4206, d7d8n: 4207, d7e8q: 4208, d7e8r: 4209, d7e8b: 4210, d7e8n: 4211, d7f8q: 4212, d7f8r: 4213, d7f8b: 4214, d7f8n: 4215, d7g8q: 4216, d7g8r: 4217, d7g8b: 4218, d7g8n: 4219, d7h8q: 4220, d7h8r: 4221, d7h8b: 4222, d7h8n: 4223, e7a8q: 4224, e7a8r: 4225, e7a8b: 4226, e7a8n: 4227, e7b8q: 4228, e7b8r: 4229, e7b8b: 4230, e7b8n: 4231, e7c8q: 4232, e7c8r: 4233, e7c8b: 4234, e7c8n: 4235, e7d8q: 4236, e7d8r: 4237, e7d8b: 4238, e7d8n: 4239, e7e8q: 4240, e7e8r: 4241, e7e8b: 4242, e7e8n: 4243, e7f8q: 4244, e7f8r: 4245, e7f8b: 4246, e7f8n: 4247, e7g8q: 4248, e7g8r: 4249, e7g8b: 4250, e7g8n: 4251, e7h8q: 4252, e7h8r: 4253, e7h8b: 4254, e7h8n: 4255, f7a8q: 4256, f7a8r: 4257, f7a8b: 4258, f7a8n: 4259, f7b8q: 4260, f7b8r: 4261, f7b8b: 4262, f7b8n: 4263, f7c8q: 4264, f7c8r: 4265, f7c8b: 4266, f7c8n: 4267, f7d8q: 4268, f7d8r: 4269, f7d8b: 4270, f7d8n: 4271, f7e8q: 4272, f7e8r: 4273, f7e8b: 4274, f7e8n: 4275, f7f8q: 4276, f7f8r: 4277, f7f8b: 4278, f7f8n: 4279, f7g8q: 4280, f7g8r: 4281, f7g8b: 4282, f7g8n: 4283, f7h8q: 4284, f7h8r: 4285, f7h8b: 4286, f7h8n: 4287, g7a8q: 4288, g7a8r: 4289, g7a8b: 4290, g7a8n: 4291, g7b8q: 4292, g7b8r: 4293, g7b8b: 4294, g7b8n: 4295, g7c8q: 4296, g7c8r: 4297, g7c8b: 4298, g7c8n: 4299, g7d8q: 4300, g7d8r: 4301, g7d8b: 4302, g7d8n: 4303, g7e8q: 4304, g7e8r: 4305, g7e8b: 4306, g7e8n: 4307, g7f8q: 4308, g7f8r: 4309, g7f8b: 4310, g7f8n: 4311, g7g8q: 4312, g7g8r: 4313, g7g8b: 4314, g7g8n: 4315, g7h8q: 4316, g7h8r: 4317, g7h8b: 4318, g7h8n: 4319, h7a8q: 4320, h7a8r: 4321, h7a8b: 4322, h7a8n: 4323, h7b8q: 4324, h7b8r: 4325, h7b8b: 4326, h7b8n: 4327, h7c8q: 4328, h7c8r: 4329, h7c8b: 4330, h7c8n: 4331, h7d8q: 4332, h7d8r: 4333, h7d8b: 4334, h7d8n: 4335, h7e8q: 4336, h7e8r: 4337, h7e8b: 4338, h7e8n: 4339, h7f8q: 4340, h7f8r: 4341, h7f8b: 4342, h7f8n: 4343, h7g8q: 4344, h7g8r: 4345, h7g8b: 4346, h7g8n: 4347, h7h8q: 4348, h7h8r: 4349, h7h8b: 4350, h7h8n: 4351 };
  }
});

// packages/maia-core/dist/data/all_moves_maia3_reversed.json
var require_all_moves_maia3_reversed = __commonJS({
  "packages/maia-core/dist/data/all_moves_maia3_reversed.json"(exports2, module2) {
    module2.exports = { "0": "a1a1", "1": "a1b1", "2": "a1c1", "3": "a1d1", "4": "a1e1", "5": "a1f1", "6": "a1g1", "7": "a1h1", "8": "a1a2", "9": "a1b2", "10": "a1c2", "11": "a1d2", "12": "a1e2", "13": "a1f2", "14": "a1g2", "15": "a1h2", "16": "a1a3", "17": "a1b3", "18": "a1c3", "19": "a1d3", "20": "a1e3", "21": "a1f3", "22": "a1g3", "23": "a1h3", "24": "a1a4", "25": "a1b4", "26": "a1c4", "27": "a1d4", "28": "a1e4", "29": "a1f4", "30": "a1g4", "31": "a1h4", "32": "a1a5", "33": "a1b5", "34": "a1c5", "35": "a1d5", "36": "a1e5", "37": "a1f5", "38": "a1g5", "39": "a1h5", "40": "a1a6", "41": "a1b6", "42": "a1c6", "43": "a1d6", "44": "a1e6", "45": "a1f6", "46": "a1g6", "47": "a1h6", "48": "a1a7", "49": "a1b7", "50": "a1c7", "51": "a1d7", "52": "a1e7", "53": "a1f7", "54": "a1g7", "55": "a1h7", "56": "a1a8", "57": "a1b8", "58": "a1c8", "59": "a1d8", "60": "a1e8", "61": "a1f8", "62": "a1g8", "63": "a1h8", "64": "b1a1", "65": "b1b1", "66": "b1c1", "67": "b1d1", "68": "b1e1", "69": "b1f1", "70": "b1g1", "71": "b1h1", "72": "b1a2", "73": "b1b2", "74": "b1c2", "75": "b1d2", "76": "b1e2", "77": "b1f2", "78": "b1g2", "79": "b1h2", "80": "b1a3", "81": "b1b3", "82": "b1c3", "83": "b1d3", "84": "b1e3", "85": "b1f3", "86": "b1g3", "87": "b1h3", "88": "b1a4", "89": "b1b4", "90": "b1c4", "91": "b1d4", "92": "b1e4", "93": "b1f4", "94": "b1g4", "95": "b1h4", "96": "b1a5", "97": "b1b5", "98": "b1c5", "99": "b1d5", "100": "b1e5", "101": "b1f5", "102": "b1g5", "103": "b1h5", "104": "b1a6", "105": "b1b6", "106": "b1c6", "107": "b1d6", "108": "b1e6", "109": "b1f6", "110": "b1g6", "111": "b1h6", "112": "b1a7", "113": "b1b7", "114": "b1c7", "115": "b1d7", "116": "b1e7", "117": "b1f7", "118": "b1g7", "119": "b1h7", "120": "b1a8", "121": "b1b8", "122": "b1c8", "123": "b1d8", "124": "b1e8", "125": "b1f8", "126": "b1g8", "127": "b1h8", "128": "c1a1", "129": "c1b1", "130": "c1c1", "131": "c1d1", "132": "c1e1", "133": "c1f1", "134": "c1g1", "135": "c1h1", "136": "c1a2", "137": "c1b2", "138": "c1c2", "139": "c1d2", "140": "c1e2", "141": "c1f2", "142": "c1g2", "143": "c1h2", "144": "c1a3", "145": "c1b3", "146": "c1c3", "147": "c1d3", "148": "c1e3", "149": "c1f3", "150": "c1g3", "151": "c1h3", "152": "c1a4", "153": "c1b4", "154": "c1c4", "155": "c1d4", "156": "c1e4", "157": "c1f4", "158": "c1g4", "159": "c1h4", "160": "c1a5", "161": "c1b5", "162": "c1c5", "163": "c1d5", "164": "c1e5", "165": "c1f5", "166": "c1g5", "167": "c1h5", "168": "c1a6", "169": "c1b6", "170": "c1c6", "171": "c1d6", "172": "c1e6", "173": "c1f6", "174": "c1g6", "175": "c1h6", "176": "c1a7", "177": "c1b7", "178": "c1c7", "179": "c1d7", "180": "c1e7", "181": "c1f7", "182": "c1g7", "183": "c1h7", "184": "c1a8", "185": "c1b8", "186": "c1c8", "187": "c1d8", "188": "c1e8", "189": "c1f8", "190": "c1g8", "191": "c1h8", "192": "d1a1", "193": "d1b1", "194": "d1c1", "195": "d1d1", "196": "d1e1", "197": "d1f1", "198": "d1g1", "199": "d1h1", "200": "d1a2", "201": "d1b2", "202": "d1c2", "203": "d1d2", "204": "d1e2", "205": "d1f2", "206": "d1g2", "207": "d1h2", "208": "d1a3", "209": "d1b3", "210": "d1c3", "211": "d1d3", "212": "d1e3", "213": "d1f3", "214": "d1g3", "215": "d1h3", "216": "d1a4", "217": "d1b4", "218": "d1c4", "219": "d1d4", "220": "d1e4", "221": "d1f4", "222": "d1g4", "223": "d1h4", "224": "d1a5", "225": "d1b5", "226": "d1c5", "227": "d1d5", "228": "d1e5", "229": "d1f5", "230": "d1g5", "231": "d1h5", "232": "d1a6", "233": "d1b6", "234": "d1c6", "235": "d1d6", "236": "d1e6", "237": "d1f6", "238": "d1g6", "239": "d1h6", "240": "d1a7", "241": "d1b7", "242": "d1c7", "243": "d1d7", "244": "d1e7", "245": "d1f7", "246": "d1g7", "247": "d1h7", "248": "d1a8", "249": "d1b8", "250": "d1c8", "251": "d1d8", "252": "d1e8", "253": "d1f8", "254": "d1g8", "255": "d1h8", "256": "e1a1", "257": "e1b1", "258": "e1c1", "259": "e1d1", "260": "e1e1", "261": "e1f1", "262": "e1g1", "263": "e1h1", "264": "e1a2", "265": "e1b2", "266": "e1c2", "267": "e1d2", "268": "e1e2", "269": "e1f2", "270": "e1g2", "271": "e1h2", "272": "e1a3", "273": "e1b3", "274": "e1c3", "275": "e1d3", "276": "e1e3", "277": "e1f3", "278": "e1g3", "279": "e1h3", "280": "e1a4", "281": "e1b4", "282": "e1c4", "283": "e1d4", "284": "e1e4", "285": "e1f4", "286": "e1g4", "287": "e1h4", "288": "e1a5", "289": "e1b5", "290": "e1c5", "291": "e1d5", "292": "e1e5", "293": "e1f5", "294": "e1g5", "295": "e1h5", "296": "e1a6", "297": "e1b6", "298": "e1c6", "299": "e1d6", "300": "e1e6", "301": "e1f6", "302": "e1g6", "303": "e1h6", "304": "e1a7", "305": "e1b7", "306": "e1c7", "307": "e1d7", "308": "e1e7", "309": "e1f7", "310": "e1g7", "311": "e1h7", "312": "e1a8", "313": "e1b8", "314": "e1c8", "315": "e1d8", "316": "e1e8", "317": "e1f8", "318": "e1g8", "319": "e1h8", "320": "f1a1", "321": "f1b1", "322": "f1c1", "323": "f1d1", "324": "f1e1", "325": "f1f1", "326": "f1g1", "327": "f1h1", "328": "f1a2", "329": "f1b2", "330": "f1c2", "331": "f1d2", "332": "f1e2", "333": "f1f2", "334": "f1g2", "335": "f1h2", "336": "f1a3", "337": "f1b3", "338": "f1c3", "339": "f1d3", "340": "f1e3", "341": "f1f3", "342": "f1g3", "343": "f1h3", "344": "f1a4", "345": "f1b4", "346": "f1c4", "347": "f1d4", "348": "f1e4", "349": "f1f4", "350": "f1g4", "351": "f1h4", "352": "f1a5", "353": "f1b5", "354": "f1c5", "355": "f1d5", "356": "f1e5", "357": "f1f5", "358": "f1g5", "359": "f1h5", "360": "f1a6", "361": "f1b6", "362": "f1c6", "363": "f1d6", "364": "f1e6", "365": "f1f6", "366": "f1g6", "367": "f1h6", "368": "f1a7", "369": "f1b7", "370": "f1c7", "371": "f1d7", "372": "f1e7", "373": "f1f7", "374": "f1g7", "375": "f1h7", "376": "f1a8", "377": "f1b8", "378": "f1c8", "379": "f1d8", "380": "f1e8", "381": "f1f8", "382": "f1g8", "383": "f1h8", "384": "g1a1", "385": "g1b1", "386": "g1c1", "387": "g1d1", "388": "g1e1", "389": "g1f1", "390": "g1g1", "391": "g1h1", "392": "g1a2", "393": "g1b2", "394": "g1c2", "395": "g1d2", "396": "g1e2", "397": "g1f2", "398": "g1g2", "399": "g1h2", "400": "g1a3", "401": "g1b3", "402": "g1c3", "403": "g1d3", "404": "g1e3", "405": "g1f3", "406": "g1g3", "407": "g1h3", "408": "g1a4", "409": "g1b4", "410": "g1c4", "411": "g1d4", "412": "g1e4", "413": "g1f4", "414": "g1g4", "415": "g1h4", "416": "g1a5", "417": "g1b5", "418": "g1c5", "419": "g1d5", "420": "g1e5", "421": "g1f5", "422": "g1g5", "423": "g1h5", "424": "g1a6", "425": "g1b6", "426": "g1c6", "427": "g1d6", "428": "g1e6", "429": "g1f6", "430": "g1g6", "431": "g1h6", "432": "g1a7", "433": "g1b7", "434": "g1c7", "435": "g1d7", "436": "g1e7", "437": "g1f7", "438": "g1g7", "439": "g1h7", "440": "g1a8", "441": "g1b8", "442": "g1c8", "443": "g1d8", "444": "g1e8", "445": "g1f8", "446": "g1g8", "447": "g1h8", "448": "h1a1", "449": "h1b1", "450": "h1c1", "451": "h1d1", "452": "h1e1", "453": "h1f1", "454": "h1g1", "455": "h1h1", "456": "h1a2", "457": "h1b2", "458": "h1c2", "459": "h1d2", "460": "h1e2", "461": "h1f2", "462": "h1g2", "463": "h1h2", "464": "h1a3", "465": "h1b3", "466": "h1c3", "467": "h1d3", "468": "h1e3", "469": "h1f3", "470": "h1g3", "471": "h1h3", "472": "h1a4", "473": "h1b4", "474": "h1c4", "475": "h1d4", "476": "h1e4", "477": "h1f4", "478": "h1g4", "479": "h1h4", "480": "h1a5", "481": "h1b5", "482": "h1c5", "483": "h1d5", "484": "h1e5", "485": "h1f5", "486": "h1g5", "487": "h1h5", "488": "h1a6", "489": "h1b6", "490": "h1c6", "491": "h1d6", "492": "h1e6", "493": "h1f6", "494": "h1g6", "495": "h1h6", "496": "h1a7", "497": "h1b7", "498": "h1c7", "499": "h1d7", "500": "h1e7", "501": "h1f7", "502": "h1g7", "503": "h1h7", "504": "h1a8", "505": "h1b8", "506": "h1c8", "507": "h1d8", "508": "h1e8", "509": "h1f8", "510": "h1g8", "511": "h1h8", "512": "a2a1", "513": "a2b1", "514": "a2c1", "515": "a2d1", "516": "a2e1", "517": "a2f1", "518": "a2g1", "519": "a2h1", "520": "a2a2", "521": "a2b2", "522": "a2c2", "523": "a2d2", "524": "a2e2", "525": "a2f2", "526": "a2g2", "527": "a2h2", "528": "a2a3", "529": "a2b3", "530": "a2c3", "531": "a2d3", "532": "a2e3", "533": "a2f3", "534": "a2g3", "535": "a2h3", "536": "a2a4", "537": "a2b4", "538": "a2c4", "539": "a2d4", "540": "a2e4", "541": "a2f4", "542": "a2g4", "543": "a2h4", "544": "a2a5", "545": "a2b5", "546": "a2c5", "547": "a2d5", "548": "a2e5", "549": "a2f5", "550": "a2g5", "551": "a2h5", "552": "a2a6", "553": "a2b6", "554": "a2c6", "555": "a2d6", "556": "a2e6", "557": "a2f6", "558": "a2g6", "559": "a2h6", "560": "a2a7", "561": "a2b7", "562": "a2c7", "563": "a2d7", "564": "a2e7", "565": "a2f7", "566": "a2g7", "567": "a2h7", "568": "a2a8", "569": "a2b8", "570": "a2c8", "571": "a2d8", "572": "a2e8", "573": "a2f8", "574": "a2g8", "575": "a2h8", "576": "b2a1", "577": "b2b1", "578": "b2c1", "579": "b2d1", "580": "b2e1", "581": "b2f1", "582": "b2g1", "583": "b2h1", "584": "b2a2", "585": "b2b2", "586": "b2c2", "587": "b2d2", "588": "b2e2", "589": "b2f2", "590": "b2g2", "591": "b2h2", "592": "b2a3", "593": "b2b3", "594": "b2c3", "595": "b2d3", "596": "b2e3", "597": "b2f3", "598": "b2g3", "599": "b2h3", "600": "b2a4", "601": "b2b4", "602": "b2c4", "603": "b2d4", "604": "b2e4", "605": "b2f4", "606": "b2g4", "607": "b2h4", "608": "b2a5", "609": "b2b5", "610": "b2c5", "611": "b2d5", "612": "b2e5", "613": "b2f5", "614": "b2g5", "615": "b2h5", "616": "b2a6", "617": "b2b6", "618": "b2c6", "619": "b2d6", "620": "b2e6", "621": "b2f6", "622": "b2g6", "623": "b2h6", "624": "b2a7", "625": "b2b7", "626": "b2c7", "627": "b2d7", "628": "b2e7", "629": "b2f7", "630": "b2g7", "631": "b2h7", "632": "b2a8", "633": "b2b8", "634": "b2c8", "635": "b2d8", "636": "b2e8", "637": "b2f8", "638": "b2g8", "639": "b2h8", "640": "c2a1", "641": "c2b1", "642": "c2c1", "643": "c2d1", "644": "c2e1", "645": "c2f1", "646": "c2g1", "647": "c2h1", "648": "c2a2", "649": "c2b2", "650": "c2c2", "651": "c2d2", "652": "c2e2", "653": "c2f2", "654": "c2g2", "655": "c2h2", "656": "c2a3", "657": "c2b3", "658": "c2c3", "659": "c2d3", "660": "c2e3", "661": "c2f3", "662": "c2g3", "663": "c2h3", "664": "c2a4", "665": "c2b4", "666": "c2c4", "667": "c2d4", "668": "c2e4", "669": "c2f4", "670": "c2g4", "671": "c2h4", "672": "c2a5", "673": "c2b5", "674": "c2c5", "675": "c2d5", "676": "c2e5", "677": "c2f5", "678": "c2g5", "679": "c2h5", "680": "c2a6", "681": "c2b6", "682": "c2c6", "683": "c2d6", "684": "c2e6", "685": "c2f6", "686": "c2g6", "687": "c2h6", "688": "c2a7", "689": "c2b7", "690": "c2c7", "691": "c2d7", "692": "c2e7", "693": "c2f7", "694": "c2g7", "695": "c2h7", "696": "c2a8", "697": "c2b8", "698": "c2c8", "699": "c2d8", "700": "c2e8", "701": "c2f8", "702": "c2g8", "703": "c2h8", "704": "d2a1", "705": "d2b1", "706": "d2c1", "707": "d2d1", "708": "d2e1", "709": "d2f1", "710": "d2g1", "711": "d2h1", "712": "d2a2", "713": "d2b2", "714": "d2c2", "715": "d2d2", "716": "d2e2", "717": "d2f2", "718": "d2g2", "719": "d2h2", "720": "d2a3", "721": "d2b3", "722": "d2c3", "723": "d2d3", "724": "d2e3", "725": "d2f3", "726": "d2g3", "727": "d2h3", "728": "d2a4", "729": "d2b4", "730": "d2c4", "731": "d2d4", "732": "d2e4", "733": "d2f4", "734": "d2g4", "735": "d2h4", "736": "d2a5", "737": "d2b5", "738": "d2c5", "739": "d2d5", "740": "d2e5", "741": "d2f5", "742": "d2g5", "743": "d2h5", "744": "d2a6", "745": "d2b6", "746": "d2c6", "747": "d2d6", "748": "d2e6", "749": "d2f6", "750": "d2g6", "751": "d2h6", "752": "d2a7", "753": "d2b7", "754": "d2c7", "755": "d2d7", "756": "d2e7", "757": "d2f7", "758": "d2g7", "759": "d2h7", "760": "d2a8", "761": "d2b8", "762": "d2c8", "763": "d2d8", "764": "d2e8", "765": "d2f8", "766": "d2g8", "767": "d2h8", "768": "e2a1", "769": "e2b1", "770": "e2c1", "771": "e2d1", "772": "e2e1", "773": "e2f1", "774": "e2g1", "775": "e2h1", "776": "e2a2", "777": "e2b2", "778": "e2c2", "779": "e2d2", "780": "e2e2", "781": "e2f2", "782": "e2g2", "783": "e2h2", "784": "e2a3", "785": "e2b3", "786": "e2c3", "787": "e2d3", "788": "e2e3", "789": "e2f3", "790": "e2g3", "791": "e2h3", "792": "e2a4", "793": "e2b4", "794": "e2c4", "795": "e2d4", "796": "e2e4", "797": "e2f4", "798": "e2g4", "799": "e2h4", "800": "e2a5", "801": "e2b5", "802": "e2c5", "803": "e2d5", "804": "e2e5", "805": "e2f5", "806": "e2g5", "807": "e2h5", "808": "e2a6", "809": "e2b6", "810": "e2c6", "811": "e2d6", "812": "e2e6", "813": "e2f6", "814": "e2g6", "815": "e2h6", "816": "e2a7", "817": "e2b7", "818": "e2c7", "819": "e2d7", "820": "e2e7", "821": "e2f7", "822": "e2g7", "823": "e2h7", "824": "e2a8", "825": "e2b8", "826": "e2c8", "827": "e2d8", "828": "e2e8", "829": "e2f8", "830": "e2g8", "831": "e2h8", "832": "f2a1", "833": "f2b1", "834": "f2c1", "835": "f2d1", "836": "f2e1", "837": "f2f1", "838": "f2g1", "839": "f2h1", "840": "f2a2", "841": "f2b2", "842": "f2c2", "843": "f2d2", "844": "f2e2", "845": "f2f2", "846": "f2g2", "847": "f2h2", "848": "f2a3", "849": "f2b3", "850": "f2c3", "851": "f2d3", "852": "f2e3", "853": "f2f3", "854": "f2g3", "855": "f2h3", "856": "f2a4", "857": "f2b4", "858": "f2c4", "859": "f2d4", "860": "f2e4", "861": "f2f4", "862": "f2g4", "863": "f2h4", "864": "f2a5", "865": "f2b5", "866": "f2c5", "867": "f2d5", "868": "f2e5", "869": "f2f5", "870": "f2g5", "871": "f2h5", "872": "f2a6", "873": "f2b6", "874": "f2c6", "875": "f2d6", "876": "f2e6", "877": "f2f6", "878": "f2g6", "879": "f2h6", "880": "f2a7", "881": "f2b7", "882": "f2c7", "883": "f2d7", "884": "f2e7", "885": "f2f7", "886": "f2g7", "887": "f2h7", "888": "f2a8", "889": "f2b8", "890": "f2c8", "891": "f2d8", "892": "f2e8", "893": "f2f8", "894": "f2g8", "895": "f2h8", "896": "g2a1", "897": "g2b1", "898": "g2c1", "899": "g2d1", "900": "g2e1", "901": "g2f1", "902": "g2g1", "903": "g2h1", "904": "g2a2", "905": "g2b2", "906": "g2c2", "907": "g2d2", "908": "g2e2", "909": "g2f2", "910": "g2g2", "911": "g2h2", "912": "g2a3", "913": "g2b3", "914": "g2c3", "915": "g2d3", "916": "g2e3", "917": "g2f3", "918": "g2g3", "919": "g2h3", "920": "g2a4", "921": "g2b4", "922": "g2c4", "923": "g2d4", "924": "g2e4", "925": "g2f4", "926": "g2g4", "927": "g2h4", "928": "g2a5", "929": "g2b5", "930": "g2c5", "931": "g2d5", "932": "g2e5", "933": "g2f5", "934": "g2g5", "935": "g2h5", "936": "g2a6", "937": "g2b6", "938": "g2c6", "939": "g2d6", "940": "g2e6", "941": "g2f6", "942": "g2g6", "943": "g2h6", "944": "g2a7", "945": "g2b7", "946": "g2c7", "947": "g2d7", "948": "g2e7", "949": "g2f7", "950": "g2g7", "951": "g2h7", "952": "g2a8", "953": "g2b8", "954": "g2c8", "955": "g2d8", "956": "g2e8", "957": "g2f8", "958": "g2g8", "959": "g2h8", "960": "h2a1", "961": "h2b1", "962": "h2c1", "963": "h2d1", "964": "h2e1", "965": "h2f1", "966": "h2g1", "967": "h2h1", "968": "h2a2", "969": "h2b2", "970": "h2c2", "971": "h2d2", "972": "h2e2", "973": "h2f2", "974": "h2g2", "975": "h2h2", "976": "h2a3", "977": "h2b3", "978": "h2c3", "979": "h2d3", "980": "h2e3", "981": "h2f3", "982": "h2g3", "983": "h2h3", "984": "h2a4", "985": "h2b4", "986": "h2c4", "987": "h2d4", "988": "h2e4", "989": "h2f4", "990": "h2g4", "991": "h2h4", "992": "h2a5", "993": "h2b5", "994": "h2c5", "995": "h2d5", "996": "h2e5", "997": "h2f5", "998": "h2g5", "999": "h2h5", "1000": "h2a6", "1001": "h2b6", "1002": "h2c6", "1003": "h2d6", "1004": "h2e6", "1005": "h2f6", "1006": "h2g6", "1007": "h2h6", "1008": "h2a7", "1009": "h2b7", "1010": "h2c7", "1011": "h2d7", "1012": "h2e7", "1013": "h2f7", "1014": "h2g7", "1015": "h2h7", "1016": "h2a8", "1017": "h2b8", "1018": "h2c8", "1019": "h2d8", "1020": "h2e8", "1021": "h2f8", "1022": "h2g8", "1023": "h2h8", "1024": "a3a1", "1025": "a3b1", "1026": "a3c1", "1027": "a3d1", "1028": "a3e1", "1029": "a3f1", "1030": "a3g1", "1031": "a3h1", "1032": "a3a2", "1033": "a3b2", "1034": "a3c2", "1035": "a3d2", "1036": "a3e2", "1037": "a3f2", "1038": "a3g2", "1039": "a3h2", "1040": "a3a3", "1041": "a3b3", "1042": "a3c3", "1043": "a3d3", "1044": "a3e3", "1045": "a3f3", "1046": "a3g3", "1047": "a3h3", "1048": "a3a4", "1049": "a3b4", "1050": "a3c4", "1051": "a3d4", "1052": "a3e4", "1053": "a3f4", "1054": "a3g4", "1055": "a3h4", "1056": "a3a5", "1057": "a3b5", "1058": "a3c5", "1059": "a3d5", "1060": "a3e5", "1061": "a3f5", "1062": "a3g5", "1063": "a3h5", "1064": "a3a6", "1065": "a3b6", "1066": "a3c6", "1067": "a3d6", "1068": "a3e6", "1069": "a3f6", "1070": "a3g6", "1071": "a3h6", "1072": "a3a7", "1073": "a3b7", "1074": "a3c7", "1075": "a3d7", "1076": "a3e7", "1077": "a3f7", "1078": "a3g7", "1079": "a3h7", "1080": "a3a8", "1081": "a3b8", "1082": "a3c8", "1083": "a3d8", "1084": "a3e8", "1085": "a3f8", "1086": "a3g8", "1087": "a3h8", "1088": "b3a1", "1089": "b3b1", "1090": "b3c1", "1091": "b3d1", "1092": "b3e1", "1093": "b3f1", "1094": "b3g1", "1095": "b3h1", "1096": "b3a2", "1097": "b3b2", "1098": "b3c2", "1099": "b3d2", "1100": "b3e2", "1101": "b3f2", "1102": "b3g2", "1103": "b3h2", "1104": "b3a3", "1105": "b3b3", "1106": "b3c3", "1107": "b3d3", "1108": "b3e3", "1109": "b3f3", "1110": "b3g3", "1111": "b3h3", "1112": "b3a4", "1113": "b3b4", "1114": "b3c4", "1115": "b3d4", "1116": "b3e4", "1117": "b3f4", "1118": "b3g4", "1119": "b3h4", "1120": "b3a5", "1121": "b3b5", "1122": "b3c5", "1123": "b3d5", "1124": "b3e5", "1125": "b3f5", "1126": "b3g5", "1127": "b3h5", "1128": "b3a6", "1129": "b3b6", "1130": "b3c6", "1131": "b3d6", "1132": "b3e6", "1133": "b3f6", "1134": "b3g6", "1135": "b3h6", "1136": "b3a7", "1137": "b3b7", "1138": "b3c7", "1139": "b3d7", "1140": "b3e7", "1141": "b3f7", "1142": "b3g7", "1143": "b3h7", "1144": "b3a8", "1145": "b3b8", "1146": "b3c8", "1147": "b3d8", "1148": "b3e8", "1149": "b3f8", "1150": "b3g8", "1151": "b3h8", "1152": "c3a1", "1153": "c3b1", "1154": "c3c1", "1155": "c3d1", "1156": "c3e1", "1157": "c3f1", "1158": "c3g1", "1159": "c3h1", "1160": "c3a2", "1161": "c3b2", "1162": "c3c2", "1163": "c3d2", "1164": "c3e2", "1165": "c3f2", "1166": "c3g2", "1167": "c3h2", "1168": "c3a3", "1169": "c3b3", "1170": "c3c3", "1171": "c3d3", "1172": "c3e3", "1173": "c3f3", "1174": "c3g3", "1175": "c3h3", "1176": "c3a4", "1177": "c3b4", "1178": "c3c4", "1179": "c3d4", "1180": "c3e4", "1181": "c3f4", "1182": "c3g4", "1183": "c3h4", "1184": "c3a5", "1185": "c3b5", "1186": "c3c5", "1187": "c3d5", "1188": "c3e5", "1189": "c3f5", "1190": "c3g5", "1191": "c3h5", "1192": "c3a6", "1193": "c3b6", "1194": "c3c6", "1195": "c3d6", "1196": "c3e6", "1197": "c3f6", "1198": "c3g6", "1199": "c3h6", "1200": "c3a7", "1201": "c3b7", "1202": "c3c7", "1203": "c3d7", "1204": "c3e7", "1205": "c3f7", "1206": "c3g7", "1207": "c3h7", "1208": "c3a8", "1209": "c3b8", "1210": "c3c8", "1211": "c3d8", "1212": "c3e8", "1213": "c3f8", "1214": "c3g8", "1215": "c3h8", "1216": "d3a1", "1217": "d3b1", "1218": "d3c1", "1219": "d3d1", "1220": "d3e1", "1221": "d3f1", "1222": "d3g1", "1223": "d3h1", "1224": "d3a2", "1225": "d3b2", "1226": "d3c2", "1227": "d3d2", "1228": "d3e2", "1229": "d3f2", "1230": "d3g2", "1231": "d3h2", "1232": "d3a3", "1233": "d3b3", "1234": "d3c3", "1235": "d3d3", "1236": "d3e3", "1237": "d3f3", "1238": "d3g3", "1239": "d3h3", "1240": "d3a4", "1241": "d3b4", "1242": "d3c4", "1243": "d3d4", "1244": "d3e4", "1245": "d3f4", "1246": "d3g4", "1247": "d3h4", "1248": "d3a5", "1249": "d3b5", "1250": "d3c5", "1251": "d3d5", "1252": "d3e5", "1253": "d3f5", "1254": "d3g5", "1255": "d3h5", "1256": "d3a6", "1257": "d3b6", "1258": "d3c6", "1259": "d3d6", "1260": "d3e6", "1261": "d3f6", "1262": "d3g6", "1263": "d3h6", "1264": "d3a7", "1265": "d3b7", "1266": "d3c7", "1267": "d3d7", "1268": "d3e7", "1269": "d3f7", "1270": "d3g7", "1271": "d3h7", "1272": "d3a8", "1273": "d3b8", "1274": "d3c8", "1275": "d3d8", "1276": "d3e8", "1277": "d3f8", "1278": "d3g8", "1279": "d3h8", "1280": "e3a1", "1281": "e3b1", "1282": "e3c1", "1283": "e3d1", "1284": "e3e1", "1285": "e3f1", "1286": "e3g1", "1287": "e3h1", "1288": "e3a2", "1289": "e3b2", "1290": "e3c2", "1291": "e3d2", "1292": "e3e2", "1293": "e3f2", "1294": "e3g2", "1295": "e3h2", "1296": "e3a3", "1297": "e3b3", "1298": "e3c3", "1299": "e3d3", "1300": "e3e3", "1301": "e3f3", "1302": "e3g3", "1303": "e3h3", "1304": "e3a4", "1305": "e3b4", "1306": "e3c4", "1307": "e3d4", "1308": "e3e4", "1309": "e3f4", "1310": "e3g4", "1311": "e3h4", "1312": "e3a5", "1313": "e3b5", "1314": "e3c5", "1315": "e3d5", "1316": "e3e5", "1317": "e3f5", "1318": "e3g5", "1319": "e3h5", "1320": "e3a6", "1321": "e3b6", "1322": "e3c6", "1323": "e3d6", "1324": "e3e6", "1325": "e3f6", "1326": "e3g6", "1327": "e3h6", "1328": "e3a7", "1329": "e3b7", "1330": "e3c7", "1331": "e3d7", "1332": "e3e7", "1333": "e3f7", "1334": "e3g7", "1335": "e3h7", "1336": "e3a8", "1337": "e3b8", "1338": "e3c8", "1339": "e3d8", "1340": "e3e8", "1341": "e3f8", "1342": "e3g8", "1343": "e3h8", "1344": "f3a1", "1345": "f3b1", "1346": "f3c1", "1347": "f3d1", "1348": "f3e1", "1349": "f3f1", "1350": "f3g1", "1351": "f3h1", "1352": "f3a2", "1353": "f3b2", "1354": "f3c2", "1355": "f3d2", "1356": "f3e2", "1357": "f3f2", "1358": "f3g2", "1359": "f3h2", "1360": "f3a3", "1361": "f3b3", "1362": "f3c3", "1363": "f3d3", "1364": "f3e3", "1365": "f3f3", "1366": "f3g3", "1367": "f3h3", "1368": "f3a4", "1369": "f3b4", "1370": "f3c4", "1371": "f3d4", "1372": "f3e4", "1373": "f3f4", "1374": "f3g4", "1375": "f3h4", "1376": "f3a5", "1377": "f3b5", "1378": "f3c5", "1379": "f3d5", "1380": "f3e5", "1381": "f3f5", "1382": "f3g5", "1383": "f3h5", "1384": "f3a6", "1385": "f3b6", "1386": "f3c6", "1387": "f3d6", "1388": "f3e6", "1389": "f3f6", "1390": "f3g6", "1391": "f3h6", "1392": "f3a7", "1393": "f3b7", "1394": "f3c7", "1395": "f3d7", "1396": "f3e7", "1397": "f3f7", "1398": "f3g7", "1399": "f3h7", "1400": "f3a8", "1401": "f3b8", "1402": "f3c8", "1403": "f3d8", "1404": "f3e8", "1405": "f3f8", "1406": "f3g8", "1407": "f3h8", "1408": "g3a1", "1409": "g3b1", "1410": "g3c1", "1411": "g3d1", "1412": "g3e1", "1413": "g3f1", "1414": "g3g1", "1415": "g3h1", "1416": "g3a2", "1417": "g3b2", "1418": "g3c2", "1419": "g3d2", "1420": "g3e2", "1421": "g3f2", "1422": "g3g2", "1423": "g3h2", "1424": "g3a3", "1425": "g3b3", "1426": "g3c3", "1427": "g3d3", "1428": "g3e3", "1429": "g3f3", "1430": "g3g3", "1431": "g3h3", "1432": "g3a4", "1433": "g3b4", "1434": "g3c4", "1435": "g3d4", "1436": "g3e4", "1437": "g3f4", "1438": "g3g4", "1439": "g3h4", "1440": "g3a5", "1441": "g3b5", "1442": "g3c5", "1443": "g3d5", "1444": "g3e5", "1445": "g3f5", "1446": "g3g5", "1447": "g3h5", "1448": "g3a6", "1449": "g3b6", "1450": "g3c6", "1451": "g3d6", "1452": "g3e6", "1453": "g3f6", "1454": "g3g6", "1455": "g3h6", "1456": "g3a7", "1457": "g3b7", "1458": "g3c7", "1459": "g3d7", "1460": "g3e7", "1461": "g3f7", "1462": "g3g7", "1463": "g3h7", "1464": "g3a8", "1465": "g3b8", "1466": "g3c8", "1467": "g3d8", "1468": "g3e8", "1469": "g3f8", "1470": "g3g8", "1471": "g3h8", "1472": "h3a1", "1473": "h3b1", "1474": "h3c1", "1475": "h3d1", "1476": "h3e1", "1477": "h3f1", "1478": "h3g1", "1479": "h3h1", "1480": "h3a2", "1481": "h3b2", "1482": "h3c2", "1483": "h3d2", "1484": "h3e2", "1485": "h3f2", "1486": "h3g2", "1487": "h3h2", "1488": "h3a3", "1489": "h3b3", "1490": "h3c3", "1491": "h3d3", "1492": "h3e3", "1493": "h3f3", "1494": "h3g3", "1495": "h3h3", "1496": "h3a4", "1497": "h3b4", "1498": "h3c4", "1499": "h3d4", "1500": "h3e4", "1501": "h3f4", "1502": "h3g4", "1503": "h3h4", "1504": "h3a5", "1505": "h3b5", "1506": "h3c5", "1507": "h3d5", "1508": "h3e5", "1509": "h3f5", "1510": "h3g5", "1511": "h3h5", "1512": "h3a6", "1513": "h3b6", "1514": "h3c6", "1515": "h3d6", "1516": "h3e6", "1517": "h3f6", "1518": "h3g6", "1519": "h3h6", "1520": "h3a7", "1521": "h3b7", "1522": "h3c7", "1523": "h3d7", "1524": "h3e7", "1525": "h3f7", "1526": "h3g7", "1527": "h3h7", "1528": "h3a8", "1529": "h3b8", "1530": "h3c8", "1531": "h3d8", "1532": "h3e8", "1533": "h3f8", "1534": "h3g8", "1535": "h3h8", "1536": "a4a1", "1537": "a4b1", "1538": "a4c1", "1539": "a4d1", "1540": "a4e1", "1541": "a4f1", "1542": "a4g1", "1543": "a4h1", "1544": "a4a2", "1545": "a4b2", "1546": "a4c2", "1547": "a4d2", "1548": "a4e2", "1549": "a4f2", "1550": "a4g2", "1551": "a4h2", "1552": "a4a3", "1553": "a4b3", "1554": "a4c3", "1555": "a4d3", "1556": "a4e3", "1557": "a4f3", "1558": "a4g3", "1559": "a4h3", "1560": "a4a4", "1561": "a4b4", "1562": "a4c4", "1563": "a4d4", "1564": "a4e4", "1565": "a4f4", "1566": "a4g4", "1567": "a4h4", "1568": "a4a5", "1569": "a4b5", "1570": "a4c5", "1571": "a4d5", "1572": "a4e5", "1573": "a4f5", "1574": "a4g5", "1575": "a4h5", "1576": "a4a6", "1577": "a4b6", "1578": "a4c6", "1579": "a4d6", "1580": "a4e6", "1581": "a4f6", "1582": "a4g6", "1583": "a4h6", "1584": "a4a7", "1585": "a4b7", "1586": "a4c7", "1587": "a4d7", "1588": "a4e7", "1589": "a4f7", "1590": "a4g7", "1591": "a4h7", "1592": "a4a8", "1593": "a4b8", "1594": "a4c8", "1595": "a4d8", "1596": "a4e8", "1597": "a4f8", "1598": "a4g8", "1599": "a4h8", "1600": "b4a1", "1601": "b4b1", "1602": "b4c1", "1603": "b4d1", "1604": "b4e1", "1605": "b4f1", "1606": "b4g1", "1607": "b4h1", "1608": "b4a2", "1609": "b4b2", "1610": "b4c2", "1611": "b4d2", "1612": "b4e2", "1613": "b4f2", "1614": "b4g2", "1615": "b4h2", "1616": "b4a3", "1617": "b4b3", "1618": "b4c3", "1619": "b4d3", "1620": "b4e3", "1621": "b4f3", "1622": "b4g3", "1623": "b4h3", "1624": "b4a4", "1625": "b4b4", "1626": "b4c4", "1627": "b4d4", "1628": "b4e4", "1629": "b4f4", "1630": "b4g4", "1631": "b4h4", "1632": "b4a5", "1633": "b4b5", "1634": "b4c5", "1635": "b4d5", "1636": "b4e5", "1637": "b4f5", "1638": "b4g5", "1639": "b4h5", "1640": "b4a6", "1641": "b4b6", "1642": "b4c6", "1643": "b4d6", "1644": "b4e6", "1645": "b4f6", "1646": "b4g6", "1647": "b4h6", "1648": "b4a7", "1649": "b4b7", "1650": "b4c7", "1651": "b4d7", "1652": "b4e7", "1653": "b4f7", "1654": "b4g7", "1655": "b4h7", "1656": "b4a8", "1657": "b4b8", "1658": "b4c8", "1659": "b4d8", "1660": "b4e8", "1661": "b4f8", "1662": "b4g8", "1663": "b4h8", "1664": "c4a1", "1665": "c4b1", "1666": "c4c1", "1667": "c4d1", "1668": "c4e1", "1669": "c4f1", "1670": "c4g1", "1671": "c4h1", "1672": "c4a2", "1673": "c4b2", "1674": "c4c2", "1675": "c4d2", "1676": "c4e2", "1677": "c4f2", "1678": "c4g2", "1679": "c4h2", "1680": "c4a3", "1681": "c4b3", "1682": "c4c3", "1683": "c4d3", "1684": "c4e3", "1685": "c4f3", "1686": "c4g3", "1687": "c4h3", "1688": "c4a4", "1689": "c4b4", "1690": "c4c4", "1691": "c4d4", "1692": "c4e4", "1693": "c4f4", "1694": "c4g4", "1695": "c4h4", "1696": "c4a5", "1697": "c4b5", "1698": "c4c5", "1699": "c4d5", "1700": "c4e5", "1701": "c4f5", "1702": "c4g5", "1703": "c4h5", "1704": "c4a6", "1705": "c4b6", "1706": "c4c6", "1707": "c4d6", "1708": "c4e6", "1709": "c4f6", "1710": "c4g6", "1711": "c4h6", "1712": "c4a7", "1713": "c4b7", "1714": "c4c7", "1715": "c4d7", "1716": "c4e7", "1717": "c4f7", "1718": "c4g7", "1719": "c4h7", "1720": "c4a8", "1721": "c4b8", "1722": "c4c8", "1723": "c4d8", "1724": "c4e8", "1725": "c4f8", "1726": "c4g8", "1727": "c4h8", "1728": "d4a1", "1729": "d4b1", "1730": "d4c1", "1731": "d4d1", "1732": "d4e1", "1733": "d4f1", "1734": "d4g1", "1735": "d4h1", "1736": "d4a2", "1737": "d4b2", "1738": "d4c2", "1739": "d4d2", "1740": "d4e2", "1741": "d4f2", "1742": "d4g2", "1743": "d4h2", "1744": "d4a3", "1745": "d4b3", "1746": "d4c3", "1747": "d4d3", "1748": "d4e3", "1749": "d4f3", "1750": "d4g3", "1751": "d4h3", "1752": "d4a4", "1753": "d4b4", "1754": "d4c4", "1755": "d4d4", "1756": "d4e4", "1757": "d4f4", "1758": "d4g4", "1759": "d4h4", "1760": "d4a5", "1761": "d4b5", "1762": "d4c5", "1763": "d4d5", "1764": "d4e5", "1765": "d4f5", "1766": "d4g5", "1767": "d4h5", "1768": "d4a6", "1769": "d4b6", "1770": "d4c6", "1771": "d4d6", "1772": "d4e6", "1773": "d4f6", "1774": "d4g6", "1775": "d4h6", "1776": "d4a7", "1777": "d4b7", "1778": "d4c7", "1779": "d4d7", "1780": "d4e7", "1781": "d4f7", "1782": "d4g7", "1783": "d4h7", "1784": "d4a8", "1785": "d4b8", "1786": "d4c8", "1787": "d4d8", "1788": "d4e8", "1789": "d4f8", "1790": "d4g8", "1791": "d4h8", "1792": "e4a1", "1793": "e4b1", "1794": "e4c1", "1795": "e4d1", "1796": "e4e1", "1797": "e4f1", "1798": "e4g1", "1799": "e4h1", "1800": "e4a2", "1801": "e4b2", "1802": "e4c2", "1803": "e4d2", "1804": "e4e2", "1805": "e4f2", "1806": "e4g2", "1807": "e4h2", "1808": "e4a3", "1809": "e4b3", "1810": "e4c3", "1811": "e4d3", "1812": "e4e3", "1813": "e4f3", "1814": "e4g3", "1815": "e4h3", "1816": "e4a4", "1817": "e4b4", "1818": "e4c4", "1819": "e4d4", "1820": "e4e4", "1821": "e4f4", "1822": "e4g4", "1823": "e4h4", "1824": "e4a5", "1825": "e4b5", "1826": "e4c5", "1827": "e4d5", "1828": "e4e5", "1829": "e4f5", "1830": "e4g5", "1831": "e4h5", "1832": "e4a6", "1833": "e4b6", "1834": "e4c6", "1835": "e4d6", "1836": "e4e6", "1837": "e4f6", "1838": "e4g6", "1839": "e4h6", "1840": "e4a7", "1841": "e4b7", "1842": "e4c7", "1843": "e4d7", "1844": "e4e7", "1845": "e4f7", "1846": "e4g7", "1847": "e4h7", "1848": "e4a8", "1849": "e4b8", "1850": "e4c8", "1851": "e4d8", "1852": "e4e8", "1853": "e4f8", "1854": "e4g8", "1855": "e4h8", "1856": "f4a1", "1857": "f4b1", "1858": "f4c1", "1859": "f4d1", "1860": "f4e1", "1861": "f4f1", "1862": "f4g1", "1863": "f4h1", "1864": "f4a2", "1865": "f4b2", "1866": "f4c2", "1867": "f4d2", "1868": "f4e2", "1869": "f4f2", "1870": "f4g2", "1871": "f4h2", "1872": "f4a3", "1873": "f4b3", "1874": "f4c3", "1875": "f4d3", "1876": "f4e3", "1877": "f4f3", "1878": "f4g3", "1879": "f4h3", "1880": "f4a4", "1881": "f4b4", "1882": "f4c4", "1883": "f4d4", "1884": "f4e4", "1885": "f4f4", "1886": "f4g4", "1887": "f4h4", "1888": "f4a5", "1889": "f4b5", "1890": "f4c5", "1891": "f4d5", "1892": "f4e5", "1893": "f4f5", "1894": "f4g5", "1895": "f4h5", "1896": "f4a6", "1897": "f4b6", "1898": "f4c6", "1899": "f4d6", "1900": "f4e6", "1901": "f4f6", "1902": "f4g6", "1903": "f4h6", "1904": "f4a7", "1905": "f4b7", "1906": "f4c7", "1907": "f4d7", "1908": "f4e7", "1909": "f4f7", "1910": "f4g7", "1911": "f4h7", "1912": "f4a8", "1913": "f4b8", "1914": "f4c8", "1915": "f4d8", "1916": "f4e8", "1917": "f4f8", "1918": "f4g8", "1919": "f4h8", "1920": "g4a1", "1921": "g4b1", "1922": "g4c1", "1923": "g4d1", "1924": "g4e1", "1925": "g4f1", "1926": "g4g1", "1927": "g4h1", "1928": "g4a2", "1929": "g4b2", "1930": "g4c2", "1931": "g4d2", "1932": "g4e2", "1933": "g4f2", "1934": "g4g2", "1935": "g4h2", "1936": "g4a3", "1937": "g4b3", "1938": "g4c3", "1939": "g4d3", "1940": "g4e3", "1941": "g4f3", "1942": "g4g3", "1943": "g4h3", "1944": "g4a4", "1945": "g4b4", "1946": "g4c4", "1947": "g4d4", "1948": "g4e4", "1949": "g4f4", "1950": "g4g4", "1951": "g4h4", "1952": "g4a5", "1953": "g4b5", "1954": "g4c5", "1955": "g4d5", "1956": "g4e5", "1957": "g4f5", "1958": "g4g5", "1959": "g4h5", "1960": "g4a6", "1961": "g4b6", "1962": "g4c6", "1963": "g4d6", "1964": "g4e6", "1965": "g4f6", "1966": "g4g6", "1967": "g4h6", "1968": "g4a7", "1969": "g4b7", "1970": "g4c7", "1971": "g4d7", "1972": "g4e7", "1973": "g4f7", "1974": "g4g7", "1975": "g4h7", "1976": "g4a8", "1977": "g4b8", "1978": "g4c8", "1979": "g4d8", "1980": "g4e8", "1981": "g4f8", "1982": "g4g8", "1983": "g4h8", "1984": "h4a1", "1985": "h4b1", "1986": "h4c1", "1987": "h4d1", "1988": "h4e1", "1989": "h4f1", "1990": "h4g1", "1991": "h4h1", "1992": "h4a2", "1993": "h4b2", "1994": "h4c2", "1995": "h4d2", "1996": "h4e2", "1997": "h4f2", "1998": "h4g2", "1999": "h4h2", "2000": "h4a3", "2001": "h4b3", "2002": "h4c3", "2003": "h4d3", "2004": "h4e3", "2005": "h4f3", "2006": "h4g3", "2007": "h4h3", "2008": "h4a4", "2009": "h4b4", "2010": "h4c4", "2011": "h4d4", "2012": "h4e4", "2013": "h4f4", "2014": "h4g4", "2015": "h4h4", "2016": "h4a5", "2017": "h4b5", "2018": "h4c5", "2019": "h4d5", "2020": "h4e5", "2021": "h4f5", "2022": "h4g5", "2023": "h4h5", "2024": "h4a6", "2025": "h4b6", "2026": "h4c6", "2027": "h4d6", "2028": "h4e6", "2029": "h4f6", "2030": "h4g6", "2031": "h4h6", "2032": "h4a7", "2033": "h4b7", "2034": "h4c7", "2035": "h4d7", "2036": "h4e7", "2037": "h4f7", "2038": "h4g7", "2039": "h4h7", "2040": "h4a8", "2041": "h4b8", "2042": "h4c8", "2043": "h4d8", "2044": "h4e8", "2045": "h4f8", "2046": "h4g8", "2047": "h4h8", "2048": "a5a1", "2049": "a5b1", "2050": "a5c1", "2051": "a5d1", "2052": "a5e1", "2053": "a5f1", "2054": "a5g1", "2055": "a5h1", "2056": "a5a2", "2057": "a5b2", "2058": "a5c2", "2059": "a5d2", "2060": "a5e2", "2061": "a5f2", "2062": "a5g2", "2063": "a5h2", "2064": "a5a3", "2065": "a5b3", "2066": "a5c3", "2067": "a5d3", "2068": "a5e3", "2069": "a5f3", "2070": "a5g3", "2071": "a5h3", "2072": "a5a4", "2073": "a5b4", "2074": "a5c4", "2075": "a5d4", "2076": "a5e4", "2077": "a5f4", "2078": "a5g4", "2079": "a5h4", "2080": "a5a5", "2081": "a5b5", "2082": "a5c5", "2083": "a5d5", "2084": "a5e5", "2085": "a5f5", "2086": "a5g5", "2087": "a5h5", "2088": "a5a6", "2089": "a5b6", "2090": "a5c6", "2091": "a5d6", "2092": "a5e6", "2093": "a5f6", "2094": "a5g6", "2095": "a5h6", "2096": "a5a7", "2097": "a5b7", "2098": "a5c7", "2099": "a5d7", "2100": "a5e7", "2101": "a5f7", "2102": "a5g7", "2103": "a5h7", "2104": "a5a8", "2105": "a5b8", "2106": "a5c8", "2107": "a5d8", "2108": "a5e8", "2109": "a5f8", "2110": "a5g8", "2111": "a5h8", "2112": "b5a1", "2113": "b5b1", "2114": "b5c1", "2115": "b5d1", "2116": "b5e1", "2117": "b5f1", "2118": "b5g1", "2119": "b5h1", "2120": "b5a2", "2121": "b5b2", "2122": "b5c2", "2123": "b5d2", "2124": "b5e2", "2125": "b5f2", "2126": "b5g2", "2127": "b5h2", "2128": "b5a3", "2129": "b5b3", "2130": "b5c3", "2131": "b5d3", "2132": "b5e3", "2133": "b5f3", "2134": "b5g3", "2135": "b5h3", "2136": "b5a4", "2137": "b5b4", "2138": "b5c4", "2139": "b5d4", "2140": "b5e4", "2141": "b5f4", "2142": "b5g4", "2143": "b5h4", "2144": "b5a5", "2145": "b5b5", "2146": "b5c5", "2147": "b5d5", "2148": "b5e5", "2149": "b5f5", "2150": "b5g5", "2151": "b5h5", "2152": "b5a6", "2153": "b5b6", "2154": "b5c6", "2155": "b5d6", "2156": "b5e6", "2157": "b5f6", "2158": "b5g6", "2159": "b5h6", "2160": "b5a7", "2161": "b5b7", "2162": "b5c7", "2163": "b5d7", "2164": "b5e7", "2165": "b5f7", "2166": "b5g7", "2167": "b5h7", "2168": "b5a8", "2169": "b5b8", "2170": "b5c8", "2171": "b5d8", "2172": "b5e8", "2173": "b5f8", "2174": "b5g8", "2175": "b5h8", "2176": "c5a1", "2177": "c5b1", "2178": "c5c1", "2179": "c5d1", "2180": "c5e1", "2181": "c5f1", "2182": "c5g1", "2183": "c5h1", "2184": "c5a2", "2185": "c5b2", "2186": "c5c2", "2187": "c5d2", "2188": "c5e2", "2189": "c5f2", "2190": "c5g2", "2191": "c5h2", "2192": "c5a3", "2193": "c5b3", "2194": "c5c3", "2195": "c5d3", "2196": "c5e3", "2197": "c5f3", "2198": "c5g3", "2199": "c5h3", "2200": "c5a4", "2201": "c5b4", "2202": "c5c4", "2203": "c5d4", "2204": "c5e4", "2205": "c5f4", "2206": "c5g4", "2207": "c5h4", "2208": "c5a5", "2209": "c5b5", "2210": "c5c5", "2211": "c5d5", "2212": "c5e5", "2213": "c5f5", "2214": "c5g5", "2215": "c5h5", "2216": "c5a6", "2217": "c5b6", "2218": "c5c6", "2219": "c5d6", "2220": "c5e6", "2221": "c5f6", "2222": "c5g6", "2223": "c5h6", "2224": "c5a7", "2225": "c5b7", "2226": "c5c7", "2227": "c5d7", "2228": "c5e7", "2229": "c5f7", "2230": "c5g7", "2231": "c5h7", "2232": "c5a8", "2233": "c5b8", "2234": "c5c8", "2235": "c5d8", "2236": "c5e8", "2237": "c5f8", "2238": "c5g8", "2239": "c5h8", "2240": "d5a1", "2241": "d5b1", "2242": "d5c1", "2243": "d5d1", "2244": "d5e1", "2245": "d5f1", "2246": "d5g1", "2247": "d5h1", "2248": "d5a2", "2249": "d5b2", "2250": "d5c2", "2251": "d5d2", "2252": "d5e2", "2253": "d5f2", "2254": "d5g2", "2255": "d5h2", "2256": "d5a3", "2257": "d5b3", "2258": "d5c3", "2259": "d5d3", "2260": "d5e3", "2261": "d5f3", "2262": "d5g3", "2263": "d5h3", "2264": "d5a4", "2265": "d5b4", "2266": "d5c4", "2267": "d5d4", "2268": "d5e4", "2269": "d5f4", "2270": "d5g4", "2271": "d5h4", "2272": "d5a5", "2273": "d5b5", "2274": "d5c5", "2275": "d5d5", "2276": "d5e5", "2277": "d5f5", "2278": "d5g5", "2279": "d5h5", "2280": "d5a6", "2281": "d5b6", "2282": "d5c6", "2283": "d5d6", "2284": "d5e6", "2285": "d5f6", "2286": "d5g6", "2287": "d5h6", "2288": "d5a7", "2289": "d5b7", "2290": "d5c7", "2291": "d5d7", "2292": "d5e7", "2293": "d5f7", "2294": "d5g7", "2295": "d5h7", "2296": "d5a8", "2297": "d5b8", "2298": "d5c8", "2299": "d5d8", "2300": "d5e8", "2301": "d5f8", "2302": "d5g8", "2303": "d5h8", "2304": "e5a1", "2305": "e5b1", "2306": "e5c1", "2307": "e5d1", "2308": "e5e1", "2309": "e5f1", "2310": "e5g1", "2311": "e5h1", "2312": "e5a2", "2313": "e5b2", "2314": "e5c2", "2315": "e5d2", "2316": "e5e2", "2317": "e5f2", "2318": "e5g2", "2319": "e5h2", "2320": "e5a3", "2321": "e5b3", "2322": "e5c3", "2323": "e5d3", "2324": "e5e3", "2325": "e5f3", "2326": "e5g3", "2327": "e5h3", "2328": "e5a4", "2329": "e5b4", "2330": "e5c4", "2331": "e5d4", "2332": "e5e4", "2333": "e5f4", "2334": "e5g4", "2335": "e5h4", "2336": "e5a5", "2337": "e5b5", "2338": "e5c5", "2339": "e5d5", "2340": "e5e5", "2341": "e5f5", "2342": "e5g5", "2343": "e5h5", "2344": "e5a6", "2345": "e5b6", "2346": "e5c6", "2347": "e5d6", "2348": "e5e6", "2349": "e5f6", "2350": "e5g6", "2351": "e5h6", "2352": "e5a7", "2353": "e5b7", "2354": "e5c7", "2355": "e5d7", "2356": "e5e7", "2357": "e5f7", "2358": "e5g7", "2359": "e5h7", "2360": "e5a8", "2361": "e5b8", "2362": "e5c8", "2363": "e5d8", "2364": "e5e8", "2365": "e5f8", "2366": "e5g8", "2367": "e5h8", "2368": "f5a1", "2369": "f5b1", "2370": "f5c1", "2371": "f5d1", "2372": "f5e1", "2373": "f5f1", "2374": "f5g1", "2375": "f5h1", "2376": "f5a2", "2377": "f5b2", "2378": "f5c2", "2379": "f5d2", "2380": "f5e2", "2381": "f5f2", "2382": "f5g2", "2383": "f5h2", "2384": "f5a3", "2385": "f5b3", "2386": "f5c3", "2387": "f5d3", "2388": "f5e3", "2389": "f5f3", "2390": "f5g3", "2391": "f5h3", "2392": "f5a4", "2393": "f5b4", "2394": "f5c4", "2395": "f5d4", "2396": "f5e4", "2397": "f5f4", "2398": "f5g4", "2399": "f5h4", "2400": "f5a5", "2401": "f5b5", "2402": "f5c5", "2403": "f5d5", "2404": "f5e5", "2405": "f5f5", "2406": "f5g5", "2407": "f5h5", "2408": "f5a6", "2409": "f5b6", "2410": "f5c6", "2411": "f5d6", "2412": "f5e6", "2413": "f5f6", "2414": "f5g6", "2415": "f5h6", "2416": "f5a7", "2417": "f5b7", "2418": "f5c7", "2419": "f5d7", "2420": "f5e7", "2421": "f5f7", "2422": "f5g7", "2423": "f5h7", "2424": "f5a8", "2425": "f5b8", "2426": "f5c8", "2427": "f5d8", "2428": "f5e8", "2429": "f5f8", "2430": "f5g8", "2431": "f5h8", "2432": "g5a1", "2433": "g5b1", "2434": "g5c1", "2435": "g5d1", "2436": "g5e1", "2437": "g5f1", "2438": "g5g1", "2439": "g5h1", "2440": "g5a2", "2441": "g5b2", "2442": "g5c2", "2443": "g5d2", "2444": "g5e2", "2445": "g5f2", "2446": "g5g2", "2447": "g5h2", "2448": "g5a3", "2449": "g5b3", "2450": "g5c3", "2451": "g5d3", "2452": "g5e3", "2453": "g5f3", "2454": "g5g3", "2455": "g5h3", "2456": "g5a4", "2457": "g5b4", "2458": "g5c4", "2459": "g5d4", "2460": "g5e4", "2461": "g5f4", "2462": "g5g4", "2463": "g5h4", "2464": "g5a5", "2465": "g5b5", "2466": "g5c5", "2467": "g5d5", "2468": "g5e5", "2469": "g5f5", "2470": "g5g5", "2471": "g5h5", "2472": "g5a6", "2473": "g5b6", "2474": "g5c6", "2475": "g5d6", "2476": "g5e6", "2477": "g5f6", "2478": "g5g6", "2479": "g5h6", "2480": "g5a7", "2481": "g5b7", "2482": "g5c7", "2483": "g5d7", "2484": "g5e7", "2485": "g5f7", "2486": "g5g7", "2487": "g5h7", "2488": "g5a8", "2489": "g5b8", "2490": "g5c8", "2491": "g5d8", "2492": "g5e8", "2493": "g5f8", "2494": "g5g8", "2495": "g5h8", "2496": "h5a1", "2497": "h5b1", "2498": "h5c1", "2499": "h5d1", "2500": "h5e1", "2501": "h5f1", "2502": "h5g1", "2503": "h5h1", "2504": "h5a2", "2505": "h5b2", "2506": "h5c2", "2507": "h5d2", "2508": "h5e2", "2509": "h5f2", "2510": "h5g2", "2511": "h5h2", "2512": "h5a3", "2513": "h5b3", "2514": "h5c3", "2515": "h5d3", "2516": "h5e3", "2517": "h5f3", "2518": "h5g3", "2519": "h5h3", "2520": "h5a4", "2521": "h5b4", "2522": "h5c4", "2523": "h5d4", "2524": "h5e4", "2525": "h5f4", "2526": "h5g4", "2527": "h5h4", "2528": "h5a5", "2529": "h5b5", "2530": "h5c5", "2531": "h5d5", "2532": "h5e5", "2533": "h5f5", "2534": "h5g5", "2535": "h5h5", "2536": "h5a6", "2537": "h5b6", "2538": "h5c6", "2539": "h5d6", "2540": "h5e6", "2541": "h5f6", "2542": "h5g6", "2543": "h5h6", "2544": "h5a7", "2545": "h5b7", "2546": "h5c7", "2547": "h5d7", "2548": "h5e7", "2549": "h5f7", "2550": "h5g7", "2551": "h5h7", "2552": "h5a8", "2553": "h5b8", "2554": "h5c8", "2555": "h5d8", "2556": "h5e8", "2557": "h5f8", "2558": "h5g8", "2559": "h5h8", "2560": "a6a1", "2561": "a6b1", "2562": "a6c1", "2563": "a6d1", "2564": "a6e1", "2565": "a6f1", "2566": "a6g1", "2567": "a6h1", "2568": "a6a2", "2569": "a6b2", "2570": "a6c2", "2571": "a6d2", "2572": "a6e2", "2573": "a6f2", "2574": "a6g2", "2575": "a6h2", "2576": "a6a3", "2577": "a6b3", "2578": "a6c3", "2579": "a6d3", "2580": "a6e3", "2581": "a6f3", "2582": "a6g3", "2583": "a6h3", "2584": "a6a4", "2585": "a6b4", "2586": "a6c4", "2587": "a6d4", "2588": "a6e4", "2589": "a6f4", "2590": "a6g4", "2591": "a6h4", "2592": "a6a5", "2593": "a6b5", "2594": "a6c5", "2595": "a6d5", "2596": "a6e5", "2597": "a6f5", "2598": "a6g5", "2599": "a6h5", "2600": "a6a6", "2601": "a6b6", "2602": "a6c6", "2603": "a6d6", "2604": "a6e6", "2605": "a6f6", "2606": "a6g6", "2607": "a6h6", "2608": "a6a7", "2609": "a6b7", "2610": "a6c7", "2611": "a6d7", "2612": "a6e7", "2613": "a6f7", "2614": "a6g7", "2615": "a6h7", "2616": "a6a8", "2617": "a6b8", "2618": "a6c8", "2619": "a6d8", "2620": "a6e8", "2621": "a6f8", "2622": "a6g8", "2623": "a6h8", "2624": "b6a1", "2625": "b6b1", "2626": "b6c1", "2627": "b6d1", "2628": "b6e1", "2629": "b6f1", "2630": "b6g1", "2631": "b6h1", "2632": "b6a2", "2633": "b6b2", "2634": "b6c2", "2635": "b6d2", "2636": "b6e2", "2637": "b6f2", "2638": "b6g2", "2639": "b6h2", "2640": "b6a3", "2641": "b6b3", "2642": "b6c3", "2643": "b6d3", "2644": "b6e3", "2645": "b6f3", "2646": "b6g3", "2647": "b6h3", "2648": "b6a4", "2649": "b6b4", "2650": "b6c4", "2651": "b6d4", "2652": "b6e4", "2653": "b6f4", "2654": "b6g4", "2655": "b6h4", "2656": "b6a5", "2657": "b6b5", "2658": "b6c5", "2659": "b6d5", "2660": "b6e5", "2661": "b6f5", "2662": "b6g5", "2663": "b6h5", "2664": "b6a6", "2665": "b6b6", "2666": "b6c6", "2667": "b6d6", "2668": "b6e6", "2669": "b6f6", "2670": "b6g6", "2671": "b6h6", "2672": "b6a7", "2673": "b6b7", "2674": "b6c7", "2675": "b6d7", "2676": "b6e7", "2677": "b6f7", "2678": "b6g7", "2679": "b6h7", "2680": "b6a8", "2681": "b6b8", "2682": "b6c8", "2683": "b6d8", "2684": "b6e8", "2685": "b6f8", "2686": "b6g8", "2687": "b6h8", "2688": "c6a1", "2689": "c6b1", "2690": "c6c1", "2691": "c6d1", "2692": "c6e1", "2693": "c6f1", "2694": "c6g1", "2695": "c6h1", "2696": "c6a2", "2697": "c6b2", "2698": "c6c2", "2699": "c6d2", "2700": "c6e2", "2701": "c6f2", "2702": "c6g2", "2703": "c6h2", "2704": "c6a3", "2705": "c6b3", "2706": "c6c3", "2707": "c6d3", "2708": "c6e3", "2709": "c6f3", "2710": "c6g3", "2711": "c6h3", "2712": "c6a4", "2713": "c6b4", "2714": "c6c4", "2715": "c6d4", "2716": "c6e4", "2717": "c6f4", "2718": "c6g4", "2719": "c6h4", "2720": "c6a5", "2721": "c6b5", "2722": "c6c5", "2723": "c6d5", "2724": "c6e5", "2725": "c6f5", "2726": "c6g5", "2727": "c6h5", "2728": "c6a6", "2729": "c6b6", "2730": "c6c6", "2731": "c6d6", "2732": "c6e6", "2733": "c6f6", "2734": "c6g6", "2735": "c6h6", "2736": "c6a7", "2737": "c6b7", "2738": "c6c7", "2739": "c6d7", "2740": "c6e7", "2741": "c6f7", "2742": "c6g7", "2743": "c6h7", "2744": "c6a8", "2745": "c6b8", "2746": "c6c8", "2747": "c6d8", "2748": "c6e8", "2749": "c6f8", "2750": "c6g8", "2751": "c6h8", "2752": "d6a1", "2753": "d6b1", "2754": "d6c1", "2755": "d6d1", "2756": "d6e1", "2757": "d6f1", "2758": "d6g1", "2759": "d6h1", "2760": "d6a2", "2761": "d6b2", "2762": "d6c2", "2763": "d6d2", "2764": "d6e2", "2765": "d6f2", "2766": "d6g2", "2767": "d6h2", "2768": "d6a3", "2769": "d6b3", "2770": "d6c3", "2771": "d6d3", "2772": "d6e3", "2773": "d6f3", "2774": "d6g3", "2775": "d6h3", "2776": "d6a4", "2777": "d6b4", "2778": "d6c4", "2779": "d6d4", "2780": "d6e4", "2781": "d6f4", "2782": "d6g4", "2783": "d6h4", "2784": "d6a5", "2785": "d6b5", "2786": "d6c5", "2787": "d6d5", "2788": "d6e5", "2789": "d6f5", "2790": "d6g5", "2791": "d6h5", "2792": "d6a6", "2793": "d6b6", "2794": "d6c6", "2795": "d6d6", "2796": "d6e6", "2797": "d6f6", "2798": "d6g6", "2799": "d6h6", "2800": "d6a7", "2801": "d6b7", "2802": "d6c7", "2803": "d6d7", "2804": "d6e7", "2805": "d6f7", "2806": "d6g7", "2807": "d6h7", "2808": "d6a8", "2809": "d6b8", "2810": "d6c8", "2811": "d6d8", "2812": "d6e8", "2813": "d6f8", "2814": "d6g8", "2815": "d6h8", "2816": "e6a1", "2817": "e6b1", "2818": "e6c1", "2819": "e6d1", "2820": "e6e1", "2821": "e6f1", "2822": "e6g1", "2823": "e6h1", "2824": "e6a2", "2825": "e6b2", "2826": "e6c2", "2827": "e6d2", "2828": "e6e2", "2829": "e6f2", "2830": "e6g2", "2831": "e6h2", "2832": "e6a3", "2833": "e6b3", "2834": "e6c3", "2835": "e6d3", "2836": "e6e3", "2837": "e6f3", "2838": "e6g3", "2839": "e6h3", "2840": "e6a4", "2841": "e6b4", "2842": "e6c4", "2843": "e6d4", "2844": "e6e4", "2845": "e6f4", "2846": "e6g4", "2847": "e6h4", "2848": "e6a5", "2849": "e6b5", "2850": "e6c5", "2851": "e6d5", "2852": "e6e5", "2853": "e6f5", "2854": "e6g5", "2855": "e6h5", "2856": "e6a6", "2857": "e6b6", "2858": "e6c6", "2859": "e6d6", "2860": "e6e6", "2861": "e6f6", "2862": "e6g6", "2863": "e6h6", "2864": "e6a7", "2865": "e6b7", "2866": "e6c7", "2867": "e6d7", "2868": "e6e7", "2869": "e6f7", "2870": "e6g7", "2871": "e6h7", "2872": "e6a8", "2873": "e6b8", "2874": "e6c8", "2875": "e6d8", "2876": "e6e8", "2877": "e6f8", "2878": "e6g8", "2879": "e6h8", "2880": "f6a1", "2881": "f6b1", "2882": "f6c1", "2883": "f6d1", "2884": "f6e1", "2885": "f6f1", "2886": "f6g1", "2887": "f6h1", "2888": "f6a2", "2889": "f6b2", "2890": "f6c2", "2891": "f6d2", "2892": "f6e2", "2893": "f6f2", "2894": "f6g2", "2895": "f6h2", "2896": "f6a3", "2897": "f6b3", "2898": "f6c3", "2899": "f6d3", "2900": "f6e3", "2901": "f6f3", "2902": "f6g3", "2903": "f6h3", "2904": "f6a4", "2905": "f6b4", "2906": "f6c4", "2907": "f6d4", "2908": "f6e4", "2909": "f6f4", "2910": "f6g4", "2911": "f6h4", "2912": "f6a5", "2913": "f6b5", "2914": "f6c5", "2915": "f6d5", "2916": "f6e5", "2917": "f6f5", "2918": "f6g5", "2919": "f6h5", "2920": "f6a6", "2921": "f6b6", "2922": "f6c6", "2923": "f6d6", "2924": "f6e6", "2925": "f6f6", "2926": "f6g6", "2927": "f6h6", "2928": "f6a7", "2929": "f6b7", "2930": "f6c7", "2931": "f6d7", "2932": "f6e7", "2933": "f6f7", "2934": "f6g7", "2935": "f6h7", "2936": "f6a8", "2937": "f6b8", "2938": "f6c8", "2939": "f6d8", "2940": "f6e8", "2941": "f6f8", "2942": "f6g8", "2943": "f6h8", "2944": "g6a1", "2945": "g6b1", "2946": "g6c1", "2947": "g6d1", "2948": "g6e1", "2949": "g6f1", "2950": "g6g1", "2951": "g6h1", "2952": "g6a2", "2953": "g6b2", "2954": "g6c2", "2955": "g6d2", "2956": "g6e2", "2957": "g6f2", "2958": "g6g2", "2959": "g6h2", "2960": "g6a3", "2961": "g6b3", "2962": "g6c3", "2963": "g6d3", "2964": "g6e3", "2965": "g6f3", "2966": "g6g3", "2967": "g6h3", "2968": "g6a4", "2969": "g6b4", "2970": "g6c4", "2971": "g6d4", "2972": "g6e4", "2973": "g6f4", "2974": "g6g4", "2975": "g6h4", "2976": "g6a5", "2977": "g6b5", "2978": "g6c5", "2979": "g6d5", "2980": "g6e5", "2981": "g6f5", "2982": "g6g5", "2983": "g6h5", "2984": "g6a6", "2985": "g6b6", "2986": "g6c6", "2987": "g6d6", "2988": "g6e6", "2989": "g6f6", "2990": "g6g6", "2991": "g6h6", "2992": "g6a7", "2993": "g6b7", "2994": "g6c7", "2995": "g6d7", "2996": "g6e7", "2997": "g6f7", "2998": "g6g7", "2999": "g6h7", "3000": "g6a8", "3001": "g6b8", "3002": "g6c8", "3003": "g6d8", "3004": "g6e8", "3005": "g6f8", "3006": "g6g8", "3007": "g6h8", "3008": "h6a1", "3009": "h6b1", "3010": "h6c1", "3011": "h6d1", "3012": "h6e1", "3013": "h6f1", "3014": "h6g1", "3015": "h6h1", "3016": "h6a2", "3017": "h6b2", "3018": "h6c2", "3019": "h6d2", "3020": "h6e2", "3021": "h6f2", "3022": "h6g2", "3023": "h6h2", "3024": "h6a3", "3025": "h6b3", "3026": "h6c3", "3027": "h6d3", "3028": "h6e3", "3029": "h6f3", "3030": "h6g3", "3031": "h6h3", "3032": "h6a4", "3033": "h6b4", "3034": "h6c4", "3035": "h6d4", "3036": "h6e4", "3037": "h6f4", "3038": "h6g4", "3039": "h6h4", "3040": "h6a5", "3041": "h6b5", "3042": "h6c5", "3043": "h6d5", "3044": "h6e5", "3045": "h6f5", "3046": "h6g5", "3047": "h6h5", "3048": "h6a6", "3049": "h6b6", "3050": "h6c6", "3051": "h6d6", "3052": "h6e6", "3053": "h6f6", "3054": "h6g6", "3055": "h6h6", "3056": "h6a7", "3057": "h6b7", "3058": "h6c7", "3059": "h6d7", "3060": "h6e7", "3061": "h6f7", "3062": "h6g7", "3063": "h6h7", "3064": "h6a8", "3065": "h6b8", "3066": "h6c8", "3067": "h6d8", "3068": "h6e8", "3069": "h6f8", "3070": "h6g8", "3071": "h6h8", "3072": "a7a1", "3073": "a7b1", "3074": "a7c1", "3075": "a7d1", "3076": "a7e1", "3077": "a7f1", "3078": "a7g1", "3079": "a7h1", "3080": "a7a2", "3081": "a7b2", "3082": "a7c2", "3083": "a7d2", "3084": "a7e2", "3085": "a7f2", "3086": "a7g2", "3087": "a7h2", "3088": "a7a3", "3089": "a7b3", "3090": "a7c3", "3091": "a7d3", "3092": "a7e3", "3093": "a7f3", "3094": "a7g3", "3095": "a7h3", "3096": "a7a4", "3097": "a7b4", "3098": "a7c4", "3099": "a7d4", "3100": "a7e4", "3101": "a7f4", "3102": "a7g4", "3103": "a7h4", "3104": "a7a5", "3105": "a7b5", "3106": "a7c5", "3107": "a7d5", "3108": "a7e5", "3109": "a7f5", "3110": "a7g5", "3111": "a7h5", "3112": "a7a6", "3113": "a7b6", "3114": "a7c6", "3115": "a7d6", "3116": "a7e6", "3117": "a7f6", "3118": "a7g6", "3119": "a7h6", "3120": "a7a7", "3121": "a7b7", "3122": "a7c7", "3123": "a7d7", "3124": "a7e7", "3125": "a7f7", "3126": "a7g7", "3127": "a7h7", "3128": "a7a8", "3129": "a7b8", "3130": "a7c8", "3131": "a7d8", "3132": "a7e8", "3133": "a7f8", "3134": "a7g8", "3135": "a7h8", "3136": "b7a1", "3137": "b7b1", "3138": "b7c1", "3139": "b7d1", "3140": "b7e1", "3141": "b7f1", "3142": "b7g1", "3143": "b7h1", "3144": "b7a2", "3145": "b7b2", "3146": "b7c2", "3147": "b7d2", "3148": "b7e2", "3149": "b7f2", "3150": "b7g2", "3151": "b7h2", "3152": "b7a3", "3153": "b7b3", "3154": "b7c3", "3155": "b7d3", "3156": "b7e3", "3157": "b7f3", "3158": "b7g3", "3159": "b7h3", "3160": "b7a4", "3161": "b7b4", "3162": "b7c4", "3163": "b7d4", "3164": "b7e4", "3165": "b7f4", "3166": "b7g4", "3167": "b7h4", "3168": "b7a5", "3169": "b7b5", "3170": "b7c5", "3171": "b7d5", "3172": "b7e5", "3173": "b7f5", "3174": "b7g5", "3175": "b7h5", "3176": "b7a6", "3177": "b7b6", "3178": "b7c6", "3179": "b7d6", "3180": "b7e6", "3181": "b7f6", "3182": "b7g6", "3183": "b7h6", "3184": "b7a7", "3185": "b7b7", "3186": "b7c7", "3187": "b7d7", "3188": "b7e7", "3189": "b7f7", "3190": "b7g7", "3191": "b7h7", "3192": "b7a8", "3193": "b7b8", "3194": "b7c8", "3195": "b7d8", "3196": "b7e8", "3197": "b7f8", "3198": "b7g8", "3199": "b7h8", "3200": "c7a1", "3201": "c7b1", "3202": "c7c1", "3203": "c7d1", "3204": "c7e1", "3205": "c7f1", "3206": "c7g1", "3207": "c7h1", "3208": "c7a2", "3209": "c7b2", "3210": "c7c2", "3211": "c7d2", "3212": "c7e2", "3213": "c7f2", "3214": "c7g2", "3215": "c7h2", "3216": "c7a3", "3217": "c7b3", "3218": "c7c3", "3219": "c7d3", "3220": "c7e3", "3221": "c7f3", "3222": "c7g3", "3223": "c7h3", "3224": "c7a4", "3225": "c7b4", "3226": "c7c4", "3227": "c7d4", "3228": "c7e4", "3229": "c7f4", "3230": "c7g4", "3231": "c7h4", "3232": "c7a5", "3233": "c7b5", "3234": "c7c5", "3235": "c7d5", "3236": "c7e5", "3237": "c7f5", "3238": "c7g5", "3239": "c7h5", "3240": "c7a6", "3241": "c7b6", "3242": "c7c6", "3243": "c7d6", "3244": "c7e6", "3245": "c7f6", "3246": "c7g6", "3247": "c7h6", "3248": "c7a7", "3249": "c7b7", "3250": "c7c7", "3251": "c7d7", "3252": "c7e7", "3253": "c7f7", "3254": "c7g7", "3255": "c7h7", "3256": "c7a8", "3257": "c7b8", "3258": "c7c8", "3259": "c7d8", "3260": "c7e8", "3261": "c7f8", "3262": "c7g8", "3263": "c7h8", "3264": "d7a1", "3265": "d7b1", "3266": "d7c1", "3267": "d7d1", "3268": "d7e1", "3269": "d7f1", "3270": "d7g1", "3271": "d7h1", "3272": "d7a2", "3273": "d7b2", "3274": "d7c2", "3275": "d7d2", "3276": "d7e2", "3277": "d7f2", "3278": "d7g2", "3279": "d7h2", "3280": "d7a3", "3281": "d7b3", "3282": "d7c3", "3283": "d7d3", "3284": "d7e3", "3285": "d7f3", "3286": "d7g3", "3287": "d7h3", "3288": "d7a4", "3289": "d7b4", "3290": "d7c4", "3291": "d7d4", "3292": "d7e4", "3293": "d7f4", "3294": "d7g4", "3295": "d7h4", "3296": "d7a5", "3297": "d7b5", "3298": "d7c5", "3299": "d7d5", "3300": "d7e5", "3301": "d7f5", "3302": "d7g5", "3303": "d7h5", "3304": "d7a6", "3305": "d7b6", "3306": "d7c6", "3307": "d7d6", "3308": "d7e6", "3309": "d7f6", "3310": "d7g6", "3311": "d7h6", "3312": "d7a7", "3313": "d7b7", "3314": "d7c7", "3315": "d7d7", "3316": "d7e7", "3317": "d7f7", "3318": "d7g7", "3319": "d7h7", "3320": "d7a8", "3321": "d7b8", "3322": "d7c8", "3323": "d7d8", "3324": "d7e8", "3325": "d7f8", "3326": "d7g8", "3327": "d7h8", "3328": "e7a1", "3329": "e7b1", "3330": "e7c1", "3331": "e7d1", "3332": "e7e1", "3333": "e7f1", "3334": "e7g1", "3335": "e7h1", "3336": "e7a2", "3337": "e7b2", "3338": "e7c2", "3339": "e7d2", "3340": "e7e2", "3341": "e7f2", "3342": "e7g2", "3343": "e7h2", "3344": "e7a3", "3345": "e7b3", "3346": "e7c3", "3347": "e7d3", "3348": "e7e3", "3349": "e7f3", "3350": "e7g3", "3351": "e7h3", "3352": "e7a4", "3353": "e7b4", "3354": "e7c4", "3355": "e7d4", "3356": "e7e4", "3357": "e7f4", "3358": "e7g4", "3359": "e7h4", "3360": "e7a5", "3361": "e7b5", "3362": "e7c5", "3363": "e7d5", "3364": "e7e5", "3365": "e7f5", "3366": "e7g5", "3367": "e7h5", "3368": "e7a6", "3369": "e7b6", "3370": "e7c6", "3371": "e7d6", "3372": "e7e6", "3373": "e7f6", "3374": "e7g6", "3375": "e7h6", "3376": "e7a7", "3377": "e7b7", "3378": "e7c7", "3379": "e7d7", "3380": "e7e7", "3381": "e7f7", "3382": "e7g7", "3383": "e7h7", "3384": "e7a8", "3385": "e7b8", "3386": "e7c8", "3387": "e7d8", "3388": "e7e8", "3389": "e7f8", "3390": "e7g8", "3391": "e7h8", "3392": "f7a1", "3393": "f7b1", "3394": "f7c1", "3395": "f7d1", "3396": "f7e1", "3397": "f7f1", "3398": "f7g1", "3399": "f7h1", "3400": "f7a2", "3401": "f7b2", "3402": "f7c2", "3403": "f7d2", "3404": "f7e2", "3405": "f7f2", "3406": "f7g2", "3407": "f7h2", "3408": "f7a3", "3409": "f7b3", "3410": "f7c3", "3411": "f7d3", "3412": "f7e3", "3413": "f7f3", "3414": "f7g3", "3415": "f7h3", "3416": "f7a4", "3417": "f7b4", "3418": "f7c4", "3419": "f7d4", "3420": "f7e4", "3421": "f7f4", "3422": "f7g4", "3423": "f7h4", "3424": "f7a5", "3425": "f7b5", "3426": "f7c5", "3427": "f7d5", "3428": "f7e5", "3429": "f7f5", "3430": "f7g5", "3431": "f7h5", "3432": "f7a6", "3433": "f7b6", "3434": "f7c6", "3435": "f7d6", "3436": "f7e6", "3437": "f7f6", "3438": "f7g6", "3439": "f7h6", "3440": "f7a7", "3441": "f7b7", "3442": "f7c7", "3443": "f7d7", "3444": "f7e7", "3445": "f7f7", "3446": "f7g7", "3447": "f7h7", "3448": "f7a8", "3449": "f7b8", "3450": "f7c8", "3451": "f7d8", "3452": "f7e8", "3453": "f7f8", "3454": "f7g8", "3455": "f7h8", "3456": "g7a1", "3457": "g7b1", "3458": "g7c1", "3459": "g7d1", "3460": "g7e1", "3461": "g7f1", "3462": "g7g1", "3463": "g7h1", "3464": "g7a2", "3465": "g7b2", "3466": "g7c2", "3467": "g7d2", "3468": "g7e2", "3469": "g7f2", "3470": "g7g2", "3471": "g7h2", "3472": "g7a3", "3473": "g7b3", "3474": "g7c3", "3475": "g7d3", "3476": "g7e3", "3477": "g7f3", "3478": "g7g3", "3479": "g7h3", "3480": "g7a4", "3481": "g7b4", "3482": "g7c4", "3483": "g7d4", "3484": "g7e4", "3485": "g7f4", "3486": "g7g4", "3487": "g7h4", "3488": "g7a5", "3489": "g7b5", "3490": "g7c5", "3491": "g7d5", "3492": "g7e5", "3493": "g7f5", "3494": "g7g5", "3495": "g7h5", "3496": "g7a6", "3497": "g7b6", "3498": "g7c6", "3499": "g7d6", "3500": "g7e6", "3501": "g7f6", "3502": "g7g6", "3503": "g7h6", "3504": "g7a7", "3505": "g7b7", "3506": "g7c7", "3507": "g7d7", "3508": "g7e7", "3509": "g7f7", "3510": "g7g7", "3511": "g7h7", "3512": "g7a8", "3513": "g7b8", "3514": "g7c8", "3515": "g7d8", "3516": "g7e8", "3517": "g7f8", "3518": "g7g8", "3519": "g7h8", "3520": "h7a1", "3521": "h7b1", "3522": "h7c1", "3523": "h7d1", "3524": "h7e1", "3525": "h7f1", "3526": "h7g1", "3527": "h7h1", "3528": "h7a2", "3529": "h7b2", "3530": "h7c2", "3531": "h7d2", "3532": "h7e2", "3533": "h7f2", "3534": "h7g2", "3535": "h7h2", "3536": "h7a3", "3537": "h7b3", "3538": "h7c3", "3539": "h7d3", "3540": "h7e3", "3541": "h7f3", "3542": "h7g3", "3543": "h7h3", "3544": "h7a4", "3545": "h7b4", "3546": "h7c4", "3547": "h7d4", "3548": "h7e4", "3549": "h7f4", "3550": "h7g4", "3551": "h7h4", "3552": "h7a5", "3553": "h7b5", "3554": "h7c5", "3555": "h7d5", "3556": "h7e5", "3557": "h7f5", "3558": "h7g5", "3559": "h7h5", "3560": "h7a6", "3561": "h7b6", "3562": "h7c6", "3563": "h7d6", "3564": "h7e6", "3565": "h7f6", "3566": "h7g6", "3567": "h7h6", "3568": "h7a7", "3569": "h7b7", "3570": "h7c7", "3571": "h7d7", "3572": "h7e7", "3573": "h7f7", "3574": "h7g7", "3575": "h7h7", "3576": "h7a8", "3577": "h7b8", "3578": "h7c8", "3579": "h7d8", "3580": "h7e8", "3581": "h7f8", "3582": "h7g8", "3583": "h7h8", "3584": "a8a1", "3585": "a8b1", "3586": "a8c1", "3587": "a8d1", "3588": "a8e1", "3589": "a8f1", "3590": "a8g1", "3591": "a8h1", "3592": "a8a2", "3593": "a8b2", "3594": "a8c2", "3595": "a8d2", "3596": "a8e2", "3597": "a8f2", "3598": "a8g2", "3599": "a8h2", "3600": "a8a3", "3601": "a8b3", "3602": "a8c3", "3603": "a8d3", "3604": "a8e3", "3605": "a8f3", "3606": "a8g3", "3607": "a8h3", "3608": "a8a4", "3609": "a8b4", "3610": "a8c4", "3611": "a8d4", "3612": "a8e4", "3613": "a8f4", "3614": "a8g4", "3615": "a8h4", "3616": "a8a5", "3617": "a8b5", "3618": "a8c5", "3619": "a8d5", "3620": "a8e5", "3621": "a8f5", "3622": "a8g5", "3623": "a8h5", "3624": "a8a6", "3625": "a8b6", "3626": "a8c6", "3627": "a8d6", "3628": "a8e6", "3629": "a8f6", "3630": "a8g6", "3631": "a8h6", "3632": "a8a7", "3633": "a8b7", "3634": "a8c7", "3635": "a8d7", "3636": "a8e7", "3637": "a8f7", "3638": "a8g7", "3639": "a8h7", "3640": "a8a8", "3641": "a8b8", "3642": "a8c8", "3643": "a8d8", "3644": "a8e8", "3645": "a8f8", "3646": "a8g8", "3647": "a8h8", "3648": "b8a1", "3649": "b8b1", "3650": "b8c1", "3651": "b8d1", "3652": "b8e1", "3653": "b8f1", "3654": "b8g1", "3655": "b8h1", "3656": "b8a2", "3657": "b8b2", "3658": "b8c2", "3659": "b8d2", "3660": "b8e2", "3661": "b8f2", "3662": "b8g2", "3663": "b8h2", "3664": "b8a3", "3665": "b8b3", "3666": "b8c3", "3667": "b8d3", "3668": "b8e3", "3669": "b8f3", "3670": "b8g3", "3671": "b8h3", "3672": "b8a4", "3673": "b8b4", "3674": "b8c4", "3675": "b8d4", "3676": "b8e4", "3677": "b8f4", "3678": "b8g4", "3679": "b8h4", "3680": "b8a5", "3681": "b8b5", "3682": "b8c5", "3683": "b8d5", "3684": "b8e5", "3685": "b8f5", "3686": "b8g5", "3687": "b8h5", "3688": "b8a6", "3689": "b8b6", "3690": "b8c6", "3691": "b8d6", "3692": "b8e6", "3693": "b8f6", "3694": "b8g6", "3695": "b8h6", "3696": "b8a7", "3697": "b8b7", "3698": "b8c7", "3699": "b8d7", "3700": "b8e7", "3701": "b8f7", "3702": "b8g7", "3703": "b8h7", "3704": "b8a8", "3705": "b8b8", "3706": "b8c8", "3707": "b8d8", "3708": "b8e8", "3709": "b8f8", "3710": "b8g8", "3711": "b8h8", "3712": "c8a1", "3713": "c8b1", "3714": "c8c1", "3715": "c8d1", "3716": "c8e1", "3717": "c8f1", "3718": "c8g1", "3719": "c8h1", "3720": "c8a2", "3721": "c8b2", "3722": "c8c2", "3723": "c8d2", "3724": "c8e2", "3725": "c8f2", "3726": "c8g2", "3727": "c8h2", "3728": "c8a3", "3729": "c8b3", "3730": "c8c3", "3731": "c8d3", "3732": "c8e3", "3733": "c8f3", "3734": "c8g3", "3735": "c8h3", "3736": "c8a4", "3737": "c8b4", "3738": "c8c4", "3739": "c8d4", "3740": "c8e4", "3741": "c8f4", "3742": "c8g4", "3743": "c8h4", "3744": "c8a5", "3745": "c8b5", "3746": "c8c5", "3747": "c8d5", "3748": "c8e5", "3749": "c8f5", "3750": "c8g5", "3751": "c8h5", "3752": "c8a6", "3753": "c8b6", "3754": "c8c6", "3755": "c8d6", "3756": "c8e6", "3757": "c8f6", "3758": "c8g6", "3759": "c8h6", "3760": "c8a7", "3761": "c8b7", "3762": "c8c7", "3763": "c8d7", "3764": "c8e7", "3765": "c8f7", "3766": "c8g7", "3767": "c8h7", "3768": "c8a8", "3769": "c8b8", "3770": "c8c8", "3771": "c8d8", "3772": "c8e8", "3773": "c8f8", "3774": "c8g8", "3775": "c8h8", "3776": "d8a1", "3777": "d8b1", "3778": "d8c1", "3779": "d8d1", "3780": "d8e1", "3781": "d8f1", "3782": "d8g1", "3783": "d8h1", "3784": "d8a2", "3785": "d8b2", "3786": "d8c2", "3787": "d8d2", "3788": "d8e2", "3789": "d8f2", "3790": "d8g2", "3791": "d8h2", "3792": "d8a3", "3793": "d8b3", "3794": "d8c3", "3795": "d8d3", "3796": "d8e3", "3797": "d8f3", "3798": "d8g3", "3799": "d8h3", "3800": "d8a4", "3801": "d8b4", "3802": "d8c4", "3803": "d8d4", "3804": "d8e4", "3805": "d8f4", "3806": "d8g4", "3807": "d8h4", "3808": "d8a5", "3809": "d8b5", "3810": "d8c5", "3811": "d8d5", "3812": "d8e5", "3813": "d8f5", "3814": "d8g5", "3815": "d8h5", "3816": "d8a6", "3817": "d8b6", "3818": "d8c6", "3819": "d8d6", "3820": "d8e6", "3821": "d8f6", "3822": "d8g6", "3823": "d8h6", "3824": "d8a7", "3825": "d8b7", "3826": "d8c7", "3827": "d8d7", "3828": "d8e7", "3829": "d8f7", "3830": "d8g7", "3831": "d8h7", "3832": "d8a8", "3833": "d8b8", "3834": "d8c8", "3835": "d8d8", "3836": "d8e8", "3837": "d8f8", "3838": "d8g8", "3839": "d8h8", "3840": "e8a1", "3841": "e8b1", "3842": "e8c1", "3843": "e8d1", "3844": "e8e1", "3845": "e8f1", "3846": "e8g1", "3847": "e8h1", "3848": "e8a2", "3849": "e8b2", "3850": "e8c2", "3851": "e8d2", "3852": "e8e2", "3853": "e8f2", "3854": "e8g2", "3855": "e8h2", "3856": "e8a3", "3857": "e8b3", "3858": "e8c3", "3859": "e8d3", "3860": "e8e3", "3861": "e8f3", "3862": "e8g3", "3863": "e8h3", "3864": "e8a4", "3865": "e8b4", "3866": "e8c4", "3867": "e8d4", "3868": "e8e4", "3869": "e8f4", "3870": "e8g4", "3871": "e8h4", "3872": "e8a5", "3873": "e8b5", "3874": "e8c5", "3875": "e8d5", "3876": "e8e5", "3877": "e8f5", "3878": "e8g5", "3879": "e8h5", "3880": "e8a6", "3881": "e8b6", "3882": "e8c6", "3883": "e8d6", "3884": "e8e6", "3885": "e8f6", "3886": "e8g6", "3887": "e8h6", "3888": "e8a7", "3889": "e8b7", "3890": "e8c7", "3891": "e8d7", "3892": "e8e7", "3893": "e8f7", "3894": "e8g7", "3895": "e8h7", "3896": "e8a8", "3897": "e8b8", "3898": "e8c8", "3899": "e8d8", "3900": "e8e8", "3901": "e8f8", "3902": "e8g8", "3903": "e8h8", "3904": "f8a1", "3905": "f8b1", "3906": "f8c1", "3907": "f8d1", "3908": "f8e1", "3909": "f8f1", "3910": "f8g1", "3911": "f8h1", "3912": "f8a2", "3913": "f8b2", "3914": "f8c2", "3915": "f8d2", "3916": "f8e2", "3917": "f8f2", "3918": "f8g2", "3919": "f8h2", "3920": "f8a3", "3921": "f8b3", "3922": "f8c3", "3923": "f8d3", "3924": "f8e3", "3925": "f8f3", "3926": "f8g3", "3927": "f8h3", "3928": "f8a4", "3929": "f8b4", "3930": "f8c4", "3931": "f8d4", "3932": "f8e4", "3933": "f8f4", "3934": "f8g4", "3935": "f8h4", "3936": "f8a5", "3937": "f8b5", "3938": "f8c5", "3939": "f8d5", "3940": "f8e5", "3941": "f8f5", "3942": "f8g5", "3943": "f8h5", "3944": "f8a6", "3945": "f8b6", "3946": "f8c6", "3947": "f8d6", "3948": "f8e6", "3949": "f8f6", "3950": "f8g6", "3951": "f8h6", "3952": "f8a7", "3953": "f8b7", "3954": "f8c7", "3955": "f8d7", "3956": "f8e7", "3957": "f8f7", "3958": "f8g7", "3959": "f8h7", "3960": "f8a8", "3961": "f8b8", "3962": "f8c8", "3963": "f8d8", "3964": "f8e8", "3965": "f8f8", "3966": "f8g8", "3967": "f8h8", "3968": "g8a1", "3969": "g8b1", "3970": "g8c1", "3971": "g8d1", "3972": "g8e1", "3973": "g8f1", "3974": "g8g1", "3975": "g8h1", "3976": "g8a2", "3977": "g8b2", "3978": "g8c2", "3979": "g8d2", "3980": "g8e2", "3981": "g8f2", "3982": "g8g2", "3983": "g8h2", "3984": "g8a3", "3985": "g8b3", "3986": "g8c3", "3987": "g8d3", "3988": "g8e3", "3989": "g8f3", "3990": "g8g3", "3991": "g8h3", "3992": "g8a4", "3993": "g8b4", "3994": "g8c4", "3995": "g8d4", "3996": "g8e4", "3997": "g8f4", "3998": "g8g4", "3999": "g8h4", "4000": "g8a5", "4001": "g8b5", "4002": "g8c5", "4003": "g8d5", "4004": "g8e5", "4005": "g8f5", "4006": "g8g5", "4007": "g8h5", "4008": "g8a6", "4009": "g8b6", "4010": "g8c6", "4011": "g8d6", "4012": "g8e6", "4013": "g8f6", "4014": "g8g6", "4015": "g8h6", "4016": "g8a7", "4017": "g8b7", "4018": "g8c7", "4019": "g8d7", "4020": "g8e7", "4021": "g8f7", "4022": "g8g7", "4023": "g8h7", "4024": "g8a8", "4025": "g8b8", "4026": "g8c8", "4027": "g8d8", "4028": "g8e8", "4029": "g8f8", "4030": "g8g8", "4031": "g8h8", "4032": "h8a1", "4033": "h8b1", "4034": "h8c1", "4035": "h8d1", "4036": "h8e1", "4037": "h8f1", "4038": "h8g1", "4039": "h8h1", "4040": "h8a2", "4041": "h8b2", "4042": "h8c2", "4043": "h8d2", "4044": "h8e2", "4045": "h8f2", "4046": "h8g2", "4047": "h8h2", "4048": "h8a3", "4049": "h8b3", "4050": "h8c3", "4051": "h8d3", "4052": "h8e3", "4053": "h8f3", "4054": "h8g3", "4055": "h8h3", "4056": "h8a4", "4057": "h8b4", "4058": "h8c4", "4059": "h8d4", "4060": "h8e4", "4061": "h8f4", "4062": "h8g4", "4063": "h8h4", "4064": "h8a5", "4065": "h8b5", "4066": "h8c5", "4067": "h8d5", "4068": "h8e5", "4069": "h8f5", "4070": "h8g5", "4071": "h8h5", "4072": "h8a6", "4073": "h8b6", "4074": "h8c6", "4075": "h8d6", "4076": "h8e6", "4077": "h8f6", "4078": "h8g6", "4079": "h8h6", "4080": "h8a7", "4081": "h8b7", "4082": "h8c7", "4083": "h8d7", "4084": "h8e7", "4085": "h8f7", "4086": "h8g7", "4087": "h8h7", "4088": "h8a8", "4089": "h8b8", "4090": "h8c8", "4091": "h8d8", "4092": "h8e8", "4093": "h8f8", "4094": "h8g8", "4095": "h8h8", "4096": "a7a8q", "4097": "a7a8r", "4098": "a7a8b", "4099": "a7a8n", "4100": "a7b8q", "4101": "a7b8r", "4102": "a7b8b", "4103": "a7b8n", "4104": "a7c8q", "4105": "a7c8r", "4106": "a7c8b", "4107": "a7c8n", "4108": "a7d8q", "4109": "a7d8r", "4110": "a7d8b", "4111": "a7d8n", "4112": "a7e8q", "4113": "a7e8r", "4114": "a7e8b", "4115": "a7e8n", "4116": "a7f8q", "4117": "a7f8r", "4118": "a7f8b", "4119": "a7f8n", "4120": "a7g8q", "4121": "a7g8r", "4122": "a7g8b", "4123": "a7g8n", "4124": "a7h8q", "4125": "a7h8r", "4126": "a7h8b", "4127": "a7h8n", "4128": "b7a8q", "4129": "b7a8r", "4130": "b7a8b", "4131": "b7a8n", "4132": "b7b8q", "4133": "b7b8r", "4134": "b7b8b", "4135": "b7b8n", "4136": "b7c8q", "4137": "b7c8r", "4138": "b7c8b", "4139": "b7c8n", "4140": "b7d8q", "4141": "b7d8r", "4142": "b7d8b", "4143": "b7d8n", "4144": "b7e8q", "4145": "b7e8r", "4146": "b7e8b", "4147": "b7e8n", "4148": "b7f8q", "4149": "b7f8r", "4150": "b7f8b", "4151": "b7f8n", "4152": "b7g8q", "4153": "b7g8r", "4154": "b7g8b", "4155": "b7g8n", "4156": "b7h8q", "4157": "b7h8r", "4158": "b7h8b", "4159": "b7h8n", "4160": "c7a8q", "4161": "c7a8r", "4162": "c7a8b", "4163": "c7a8n", "4164": "c7b8q", "4165": "c7b8r", "4166": "c7b8b", "4167": "c7b8n", "4168": "c7c8q", "4169": "c7c8r", "4170": "c7c8b", "4171": "c7c8n", "4172": "c7d8q", "4173": "c7d8r", "4174": "c7d8b", "4175": "c7d8n", "4176": "c7e8q", "4177": "c7e8r", "4178": "c7e8b", "4179": "c7e8n", "4180": "c7f8q", "4181": "c7f8r", "4182": "c7f8b", "4183": "c7f8n", "4184": "c7g8q", "4185": "c7g8r", "4186": "c7g8b", "4187": "c7g8n", "4188": "c7h8q", "4189": "c7h8r", "4190": "c7h8b", "4191": "c7h8n", "4192": "d7a8q", "4193": "d7a8r", "4194": "d7a8b", "4195": "d7a8n", "4196": "d7b8q", "4197": "d7b8r", "4198": "d7b8b", "4199": "d7b8n", "4200": "d7c8q", "4201": "d7c8r", "4202": "d7c8b", "4203": "d7c8n", "4204": "d7d8q", "4205": "d7d8r", "4206": "d7d8b", "4207": "d7d8n", "4208": "d7e8q", "4209": "d7e8r", "4210": "d7e8b", "4211": "d7e8n", "4212": "d7f8q", "4213": "d7f8r", "4214": "d7f8b", "4215": "d7f8n", "4216": "d7g8q", "4217": "d7g8r", "4218": "d7g8b", "4219": "d7g8n", "4220": "d7h8q", "4221": "d7h8r", "4222": "d7h8b", "4223": "d7h8n", "4224": "e7a8q", "4225": "e7a8r", "4226": "e7a8b", "4227": "e7a8n", "4228": "e7b8q", "4229": "e7b8r", "4230": "e7b8b", "4231": "e7b8n", "4232": "e7c8q", "4233": "e7c8r", "4234": "e7c8b", "4235": "e7c8n", "4236": "e7d8q", "4237": "e7d8r", "4238": "e7d8b", "4239": "e7d8n", "4240": "e7e8q", "4241": "e7e8r", "4242": "e7e8b", "4243": "e7e8n", "4244": "e7f8q", "4245": "e7f8r", "4246": "e7f8b", "4247": "e7f8n", "4248": "e7g8q", "4249": "e7g8r", "4250": "e7g8b", "4251": "e7g8n", "4252": "e7h8q", "4253": "e7h8r", "4254": "e7h8b", "4255": "e7h8n", "4256": "f7a8q", "4257": "f7a8r", "4258": "f7a8b", "4259": "f7a8n", "4260": "f7b8q", "4261": "f7b8r", "4262": "f7b8b", "4263": "f7b8n", "4264": "f7c8q", "4265": "f7c8r", "4266": "f7c8b", "4267": "f7c8n", "4268": "f7d8q", "4269": "f7d8r", "4270": "f7d8b", "4271": "f7d8n", "4272": "f7e8q", "4273": "f7e8r", "4274": "f7e8b", "4275": "f7e8n", "4276": "f7f8q", "4277": "f7f8r", "4278": "f7f8b", "4279": "f7f8n", "4280": "f7g8q", "4281": "f7g8r", "4282": "f7g8b", "4283": "f7g8n", "4284": "f7h8q", "4285": "f7h8r", "4286": "f7h8b", "4287": "f7h8n", "4288": "g7a8q", "4289": "g7a8r", "4290": "g7a8b", "4291": "g7a8n", "4292": "g7b8q", "4293": "g7b8r", "4294": "g7b8b", "4295": "g7b8n", "4296": "g7c8q", "4297": "g7c8r", "4298": "g7c8b", "4299": "g7c8n", "4300": "g7d8q", "4301": "g7d8r", "4302": "g7d8b", "4303": "g7d8n", "4304": "g7e8q", "4305": "g7e8r", "4306": "g7e8b", "4307": "g7e8n", "4308": "g7f8q", "4309": "g7f8r", "4310": "g7f8b", "4311": "g7f8n", "4312": "g7g8q", "4313": "g7g8r", "4314": "g7g8b", "4315": "g7g8n", "4316": "g7h8q", "4317": "g7h8r", "4318": "g7h8b", "4319": "g7h8n", "4320": "h7a8q", "4321": "h7a8r", "4322": "h7a8b", "4323": "h7a8n", "4324": "h7b8q", "4325": "h7b8r", "4326": "h7b8b", "4327": "h7b8n", "4328": "h7c8q", "4329": "h7c8r", "4330": "h7c8b", "4331": "h7c8n", "4332": "h7d8q", "4333": "h7d8r", "4334": "h7d8b", "4335": "h7d8n", "4336": "h7e8q", "4337": "h7e8r", "4338": "h7e8b", "4339": "h7e8n", "4340": "h7f8q", "4341": "h7f8r", "4342": "h7f8b", "4343": "h7f8n", "4344": "h7g8q", "4345": "h7g8r", "4346": "h7g8b", "4347": "h7g8n", "4348": "h7h8q", "4349": "h7h8r", "4350": "h7h8b", "4351": "h7h8n" };
  }
});

// packages/maia-core/dist/tensor.js
var require_tensor = __commonJS({
  "packages/maia-core/dist/tensor.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MAIA3_MOVE_VOCAB_SIZE = exports2.allPossibleMovesMaia3Reversed = exports2.allPossibleMovesMaia3 = void 0;
    exports2.mirrorMove = mirrorMove;
    exports2.preprocessMaia3 = preprocessMaia3;
    var chess_js_1 = require_chess();
    var all_moves_maia3_json_1 = __importDefault(require_all_moves_maia3());
    var all_moves_maia3_reversed_json_1 = __importDefault(require_all_moves_maia3_reversed());
    exports2.allPossibleMovesMaia3 = all_moves_maia3_json_1.default;
    exports2.allPossibleMovesMaia3Reversed = all_moves_maia3_reversed_json_1.default;
    exports2.MAIA3_MOVE_VOCAB_SIZE = Object.keys(exports2.allPossibleMovesMaia3).length;
    function boardToMaia3Tokens(fen) {
      const tokens = fen.split(" ");
      const piecePlacement = tokens[0];
      const pieceTypes = [
        "P",
        "N",
        "B",
        "R",
        "Q",
        "K",
        "p",
        "n",
        "b",
        "r",
        "q",
        "k"
      ];
      const tensor = new Float32Array(64 * 12);
      const rows = piecePlacement.split("/");
      for (let rank = 0; rank < 8; rank++) {
        const row = 7 - rank;
        let file = 0;
        for (const char of rows[rank]) {
          if (Number.isNaN(parseInt(char, 10))) {
            const pieceIdx = pieceTypes.indexOf(char);
            if (pieceIdx >= 0) {
              const square = row * 8 + file;
              tensor[square * 12 + pieceIdx] = 1;
            }
            file += 1;
          } else {
            file += parseInt(char, 10);
          }
        }
      }
      return tensor;
    }
    function mirrorSquare(square) {
      const fileChar = square.charAt(0);
      const rank = (9 - parseInt(square.charAt(1), 10)).toString();
      return fileChar + rank;
    }
    function mirrorMove(moveUci) {
      const isPromotion = moveUci.length > 4;
      const startSquare = moveUci.substring(0, 2);
      const endSquare = moveUci.substring(2, 4);
      const promotionPiece = isPromotion ? moveUci.substring(4) : "";
      return mirrorSquare(startSquare) + mirrorSquare(endSquare) + promotionPiece;
    }
    function swapColorsInRank(rank) {
      let swappedRank = "";
      for (const char of rank) {
        if (/[A-Z]/.test(char)) {
          swappedRank += char.toLowerCase();
        } else if (/[a-z]/.test(char)) {
          swappedRank += char.toUpperCase();
        } else {
          swappedRank += char;
        }
      }
      return swappedRank;
    }
    function swapCastlingRights(castling) {
      if (castling === "-")
        return "-";
      const rights = new Set(castling.split(""));
      const swapped = /* @__PURE__ */ new Set();
      if (rights.has("K"))
        swapped.add("k");
      if (rights.has("Q"))
        swapped.add("q");
      if (rights.has("k"))
        swapped.add("K");
      if (rights.has("q"))
        swapped.add("Q");
      let output = "";
      if (swapped.has("K"))
        output += "K";
      if (swapped.has("Q"))
        output += "Q";
      if (swapped.has("k"))
        output += "k";
      if (swapped.has("q"))
        output += "q";
      return output === "" ? "-" : output;
    }
    function mirrorFEN(fen) {
      const [position, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(" ");
      const ranks = position.split("/");
      const mirroredRanks = ranks.slice().reverse().map((rank) => swapColorsInRank(rank));
      const mirroredPosition = mirroredRanks.join("/");
      const mirroredActiveColor = activeColor === "w" ? "b" : "w";
      const mirroredCastling = swapCastlingRights(castling);
      const mirroredEnPassant = enPassant !== "-" ? mirrorSquare(enPassant) : "-";
      return `${mirroredPosition} ${mirroredActiveColor} ${mirroredCastling} ${mirroredEnPassant} ${halfmove} ${fullmove}`;
    }
    function preprocessMaia3(fen) {
      const sideToMove = fen.split(" ")[1];
      if (sideToMove !== "w" && sideToMove !== "b") {
        throw new Error(`Invalid FEN (no side to move): ${fen}`);
      }
      const blackToMove = sideToMove === "b";
      let board = new chess_js_1.Chess(fen);
      if (blackToMove) {
        board = new chess_js_1.Chess(mirrorFEN(board.fen()));
      }
      const boardTokens = boardToMaia3Tokens(board.fen());
      const legalMoves = new Float32Array(exports2.MAIA3_MOVE_VOCAB_SIZE);
      for (const move of board.moves({ verbose: true })) {
        const promotion = move.promotion ? move.promotion : "";
        const moveIndex = exports2.allPossibleMovesMaia3[move.from + move.to + promotion];
        if (moveIndex !== void 0) {
          legalMoves[moveIndex] = 1;
        }
      }
      return { boardTokens, legalMoves, blackToMove };
    }
  }
});

// packages/maia-core/dist/engine.js
var require_engine = __commonJS({
  "packages/maia-core/dist/engine.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Maia = void 0;
    exports2.postprocessMaia3 = postprocessMaia3;
    var tensor_js_1 = require_tensor();
    var Maia2 = class {
      config;
      session = null;
      sessionPromise = null;
      constructor(config) {
        this.config = config;
      }
      /** Гарантирует, что сессия создана. Идемпотентно, потокобезопасно. */
      async ensureSession() {
        if (this.session)
          return this.session;
        if (this.sessionPromise)
          return this.sessionPromise;
        this.sessionPromise = (async () => {
          const buffer = await this.config.fetchBuffer();
          const session = await this.config.provider.createSession(buffer);
          this.session = session;
          return session;
        })();
        try {
          return await this.sessionPromise;
        } catch (err) {
          this.sessionPromise = null;
          throw err;
        }
      }
      /**
       * Предсказывает распределение ходов для FEN на данных ELO.
       *
       * ELO интерпретируется Maia-3 как непрерывный сигнал (не категория).
       * `eloSelf` — рейтинг ходящего, `eloOpponent` — рейтинг оппонента.
       */
      async predictMoves(fen, eloSelf, eloOpponent) {
        const session = await this.ensureSession();
        const provider = this.config.provider;
        const { boardTokens, legalMoves, blackToMove } = (0, tensor_js_1.preprocessMaia3)(fen);
        const feeds = {
          tokens: new provider.Tensor("float32", boardTokens, [1, 64, 12]),
          elo_self: new provider.Tensor("float32", Float32Array.from([eloSelf]), [
            1
          ]),
          elo_oppo: new provider.Tensor("float32", Float32Array.from([eloOpponent]), [1])
        };
        const outputs = await session.run(feeds);
        const logitsMove = outputs.logits_move.data;
        const logitsValue = outputs.logits_value.data;
        if (logitsMove.length !== tensor_js_1.MAIA3_MOVE_VOCAB_SIZE) {
          throw new Error(`Maia: logits_move length mismatch \u2014 got ${logitsMove.length}, expected ${tensor_js_1.MAIA3_MOVE_VOCAB_SIZE}`);
        }
        return postprocessMaia3(logitsMove, logitsValue, legalMoves, blackToMove);
      }
    };
    exports2.Maia = Maia2;
    function postprocessMaia3(logitsMove, logitsValue, legalMoves, blackToMove) {
      const maxWdl = Math.max(logitsValue[0], logitsValue[1], logitsValue[2]);
      const expL = Math.exp(logitsValue[0] - maxWdl);
      const expD = Math.exp(logitsValue[1] - maxWdl);
      const expW = Math.exp(logitsValue[2] - maxWdl);
      const sumExp = expL + expD + expW;
      let winProb = (expW + 0.5 * expD) / sumExp;
      if (blackToMove)
        winProb = 1 - winProb;
      winProb = Math.round(winProb * 1e4) / 1e4;
      const legalIndices = [];
      for (let i = 0; i < legalMoves.length; i++) {
        if (legalMoves[i] > 0)
          legalIndices.push(i);
      }
      if (legalIndices.length === 0) {
        return { policy: [], winProbability: winProb };
      }
      let maxLogit = -Infinity;
      for (const idx of legalIndices) {
        const value = logitsMove[idx];
        if (value > maxLogit)
          maxLogit = value;
      }
      const expValues = new Float32Array(legalIndices.length);
      let sumExpMoves = 0;
      for (let i = 0; i < legalIndices.length; i++) {
        const v = Math.exp(logitsMove[legalIndices[i]] - maxLogit);
        expValues[i] = v;
        sumExpMoves += v;
      }
      const policy = legalIndices.map((idx, i) => {
        let uci = tensor_js_1.allPossibleMovesMaia3Reversed[idx];
        if (blackToMove)
          uci = (0, tensor_js_1.mirrorMove)(uci);
        return {
          move: uci,
          probability: expValues[i] / sumExpMoves
        };
      });
      policy.sort((a, b) => b.probability - a.probability);
      return { policy, winProbability: winProb };
    }
  }
});

// packages/maia-core/dist/node-provider.js
var require_node_provider = __commonJS({
  "packages/maia-core/dist/node-provider.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ (function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    })();
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createNodeProvider = createNodeProvider2;
    exports2.loadModelFromFs = loadModelFromFs2;
    var ort = __importStar(require("onnxruntime-web"));
    function createNodeProvider2() {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return {
        Tensor: ort.Tensor,
        createSession: async (buffer) => {
          const session = await ort.InferenceSession.create(buffer, {
            executionProviders: ["wasm"]
          });
          return {
            run: async (feeds) => {
              const result = await session.run(feeds);
              return result;
            }
          };
        }
      };
    }
    async function loadModelFromFs2(modelPath) {
      const { readFile } = await import("node:fs/promises");
      const file = await readFile(modelPath);
      return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    }
  }
});

// packages/maia-core/dist/weak-choice.js
var require_weak_choice = __commonJS({
  "packages/maia-core/dist/weak-choice.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WEAK_LOSS_E_THRESHOLD = exports2.WEAK_LOSS_E_SOFT_WIDTH = exports2.WEAK_LOSS_E_CENTER = exports2.MAIA_TOP_K_MAX = exports2.MAIA_TOP_K_POLICY_THRESHOLD = exports2.MAIA_WEAK_CHOICE_METRIC_VERSION = void 0;
    exports2.weakWeight = weakWeight;
    exports2.buildMaiaSearchMoves = buildMaiaSearchMoves;
    exports2.computeWeakChoiceProb = computeWeakChoiceProb;
    exports2.MAIA_WEAK_CHOICE_METRIC_VERSION = 2;
    exports2.MAIA_TOP_K_POLICY_THRESHOLD = 0.1;
    exports2.MAIA_TOP_K_MAX = 8;
    exports2.WEAK_LOSS_E_CENTER = 0.02;
    exports2.WEAK_LOSS_E_SOFT_WIDTH = 0.01;
    exports2.WEAK_LOSS_E_THRESHOLD = exports2.WEAK_LOSS_E_CENTER;
    function weakWeight(lossE, center = exports2.WEAK_LOSS_E_CENTER, width = exports2.WEAK_LOSS_E_SOFT_WIDTH) {
      if (width <= 0) {
        return lossE > center ? 1 : 0;
      }
      const lower = center - width / 2;
      const t = (lossE - lower) / width;
      if (t <= 0)
        return 0;
      if (t >= 1)
        return 1;
      return t;
    }
    function buildMaiaSearchMoves(policy, firstMovePV1) {
      const sorted = [...policy].sort((a, b) => b.probability - a.probability);
      const maiaTopK = [];
      for (const entry of sorted) {
        if (entry.probability <= exports2.MAIA_TOP_K_POLICY_THRESHOLD)
          break;
        maiaTopK.push(entry.move);
        if (maiaTopK.length >= exports2.MAIA_TOP_K_MAX)
          break;
      }
      const searchMovesSet = /* @__PURE__ */ new Set();
      if (firstMovePV1)
        searchMovesSet.add(firstMovePV1);
      for (const m of maiaTopK)
        searchMovesSet.add(m);
      return { maiaTopK, searchMoves: Array.from(searchMovesSet) };
    }
    function computeWeakChoiceProb(input) {
      const { maiaTopK, searchMoves } = buildMaiaSearchMoves(input.policy, input.firstMovePV1);
      let bestE = -Infinity;
      for (const m of searchMoves) {
        const e = input.expectedScores.get(m);
        if (e !== void 0 && e > bestE)
          bestE = e;
      }
      if (bestE === -Infinity) {
        return {
          weakChoiceProb: 0,
          maiaTopK,
          searchMoves,
          bestExpectedScore: 0,
          weakSet: []
        };
      }
      const policyByMove = /* @__PURE__ */ new Map();
      for (const p of input.policy)
        policyByMove.set(p.move, p.probability);
      const center = input.weakLossCenter ?? exports2.WEAK_LOSS_E_CENTER;
      const width = input.weakLossSoftWidth ?? exports2.WEAK_LOSS_E_SOFT_WIDTH;
      const weakSet = [];
      let weakChoiceProb = 0;
      for (const move of maiaTopK) {
        const e = input.expectedScores.get(move);
        if (e === void 0)
          continue;
        const lossE = bestE - e;
        const weight = weakWeight(lossE, center, width);
        if (weight <= 0)
          continue;
        const policy = policyByMove.get(move) ?? 0;
        weakSet.push({ move, policy, lossE, weight });
        weakChoiceProb += policy * weight;
      }
      return {
        weakChoiceProb,
        maiaTopK,
        searchMoves,
        bestExpectedScore: bestE,
        weakSet
      };
    }
  }
});

// packages/shared/dist/types/game.js
var require_game = __commonJS({
  "packages/shared/dist/types/game.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/user.js
var require_user = __commonJS({
  "packages/shared/dist/types/user.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/puzzle.js
var require_puzzle = __commonJS({
  "packages/shared/dist/types/puzzle.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/puzzle-gen.js
var require_puzzle_gen = __commonJS({
  "packages/shared/dist/types/puzzle-gen.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PUZZLE_GEN_DEFAULTS = void 0;
    exports2.PUZZLE_GEN_DEFAULTS = {
      /**
       * KS-3135 / ADR-068 §1.2, §5.4. Порог по падению вероятности победы
       * блaндера за один ход: `deltaW = (W_до − L_после_raw) / 1000 ≥ X`.
       * Триггер пазла — OR с `deltaDThreshold`. Default 0.6 (= 60 п.п.,
       * совместимо по поведению с прошлой свёрткой `blunderΔ ≥ 0.6` для
       * чисто win/loss-сценариев).
       */
      deltaWThreshold: 0.6,
      /**
       * KS-3135 / ADR-068 §1.2, §5.4. Порог по падению вероятности ничьи
       * блaндера за один ход: `deltaD = (D_до − D_после) / 1000 ≥ X`.
       * Default 0.6. Триггерит «упустил ничью»-пазлы, которые прошлая
       * свёртка распознавала только за счёт роста L, а не D.
       */
      deltaDThreshold: 0.6,
      /**
       * Глубина анализа решения (полуходов после блaндера). По умолчанию 6
       * — типичная длина тактической комбинации.
       */
      halfMovesN: 6,
      /**
       * Минимальный WDL_signed после правильного хода соперника, чтобы
       * считать пазл «решённым» (победа достигнута).
       */
      winThreshold: 0.5,
      /**
       * Максимальный WDL_signed после ошибочного хода соперника, чтобы
       * считать пазл «не решённым» (порог сваливания).
       */
      failThreshold: 0,
      /**
       * Если |WDL_signed| ≥ skipDecidedWdl уже до блaндера — пропускаем
       * позицию (партия уже решена, новый блaндер тактически не интересен).
       */
      skipDecidedWdl: 0.95,
      /**
       * KS-3135 / ADR-068 §3.2, §5.4. KS-3140 (rev2): единый after-фильтр —
       * минимальная сумма `W + D` решающего сразу после хода блaндера
       * (хотя бы «держать ничью»). Применяется ко всем триггерам (W, D, WD)
       * единообразно. Защита от пазлов, где решающий после зевка всё ещё в
       * проигрышной позиции; одновременно — пропуск пазлов «реализуй
       * перевес» (W_after велик) и «спасение в ничью» (D_after велик при
       * W_after≈0). Прежний `minWAfterForSolver` удалён в KS-3140.
       */
      minWPlusDAfterForSolver: 0.5,
      /**
       * Стартовый ply анализа партии. Раньше — дебютная теория (cp ≠
       * объективная оценка), пазлы не ищем.
       */
      startPly: 20,
      /**
       * KS-3157 / ADR-070 §2.2. Минимальный Elo обоих игроков партии для
       * допуска в обработку. Default 0 = принимаем всех (клиентский
       * режим — пользователь генерит из своих партий). Серверный
       * tactic-worker в своей обёртке переопределяет на 2400 (TWIC
       * фильтр-уровень по запросу пользователя).
       */
      minPlayerElo: 0
    };
  }
});

// packages/shared/dist/types/lessons.js
var require_lessons = __commonJS({
  "packages/shared/dist/types/lessons.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DRILL_BUCKET_TO_DIFFICULTY = void 0;
    exports2.DRILL_BUCKET_TO_DIFFICULTY = {
      easy: [1, 2],
      medium: [3],
      hard: [4, 5]
    };
  }
});

// packages/shared/dist/types/user-courses.js
var require_user_courses = __commonJS({
  "packages/shared/dist/types/user-courses.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/video-url.js
var require_video_url = __commonJS({
  "packages/shared/dist/types/video-url.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ALLOWED_VIDEO_HOSTS = void 0;
    exports2.isAllowedVideoUrl = isAllowedVideoUrl;
    exports2.ALLOWED_VIDEO_HOSTS = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
      "vimeo.com",
      "www.vimeo.com",
      "player.vimeo.com"
    ];
    function isAllowedVideoUrl(url) {
      if (typeof url !== "string" || url.length === 0)
        return false;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return false;
      const host = parsed.hostname.toLowerCase();
      return exports2.ALLOWED_VIDEO_HOSTS.includes(host);
    }
  }
});

// packages/shared/dist/types/archive.js
var require_archive = __commonJS({
  "packages/shared/dist/types/archive.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/api-contracts.js
var require_api_contracts = __commonJS({
  "packages/shared/dist/types/api-contracts.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ALL_LECTURE_DISABLED_TOOLS = exports2.DEFAULT_BLIND_BOARD_CONFIG = exports2.LEVEL_DURATION_PRESETS = exports2.BLIND_BOARD_LIMITS = exports2.ChallengeEvents = exports2.FriendEvents = exports2.SpectatorEvents = exports2.MessageEvents = exports2.BroadcastEvents = exports2.MatchmakingEvents = exports2.GameEvents = exports2.NotificationEvents = void 0;
    exports2.isDefaultBlindBoardConfig = isDefaultBlindBoardConfig;
    __exportStar(require_archive(), exports2);
    exports2.NotificationEvents = {
      NEW: "notification:new"
    };
    exports2.GameEvents = {
      // client → server
      JOIN: "game:join",
      MOVE: "game:move",
      RESIGN: "game:resign",
      DRAW_OFFER: "game:draw:offer",
      DRAW_ACCEPT: "game:draw:accept",
      DRAW_DECLINE: "game:draw:decline",
      CHAT_SEND: "chat:send",
      ANALYSIS_START: "analysis:start",
      ANALYSIS_STOP: "analysis:stop",
      // server → client
      STATE: "game:state",
      MOVE_SERVER: "game:move",
      END: "game:end",
      DRAW_OFFERED: "game:draw:offered",
      CHAT_MESSAGE: "chat:message",
      ERROR: "error",
      ANALYSIS_LINE: "analysis:line",
      ANALYSIS_DONE: "analysis:done"
    };
    exports2.MatchmakingEvents = {
      JOIN: "matchmaking:join",
      LEAVE: "matchmaking:leave",
      FOUND: "matchmaking:found",
      /**
       * KS-2197. Server → Client: после
       * `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS` без пары сервер автоматически
       * вызывает LEAVE и шлёт это событие. Payload —
       * {@link WsMatchmakingNoOpponentsPayload}.
       */
      NO_OPPONENTS: "matchmaking:no_opponents",
      ERROR: "error"
    };
    exports2.BroadcastEvents = {
      // client → server
      SUBSCRIBE: "broadcast:subscribe",
      UNSUBSCRIBE: "broadcast:unsubscribe",
      // server → client
      MOVE: "broadcast:move",
      SYNC: "broadcast:sync",
      ERROR: "error"
    };
    exports2.MessageEvents = {
      NEW_MESSAGE: "message:new",
      ERROR: "error"
    };
    exports2.SpectatorEvents = {
      /** Client → Server: join as spectator */
      SPECTATE_JOIN: "spectate:join",
      /** Client → Server: leave spectating */
      SPECTATE_LEAVE: "spectate:leave",
      /** Server → Client: delayed move */
      SPECTATE_MOVE: "spectate:move",
      /** Server → Client: game state for spectator */
      SPECTATE_STATE: "spectate:state",
      /** Server → Client: game ended */
      SPECTATE_END: "spectate:end"
    };
    exports2.FriendEvents = {
      REQUEST_RECEIVED: "friend:request:received",
      REQUEST_ACCEPTED: "friend:request:accepted",
      STATUS_ONLINE: "friend:status:online",
      STATUS_OFFLINE: "friend:status:offline"
    };
    exports2.ChallengeEvents = {
      SEND: "game:challenge:send",
      RECEIVED: "game:challenge:received",
      ACCEPT: "game:challenge:accept",
      DECLINE: "game:challenge:decline",
      STARTED: "game:challenge:started",
      ERROR: "game:challenge:error"
    };
    exports2.BLIND_BOARD_LIMITS = {
      /** Минимум фигур в startPieces. */
      minStart: 3,
      /** Максимум фигур на доске (startPieces + addOrder в сумме). */
      maxTotal: 7,
      /** Квоты по типам фигур на доске. */
      maxByType: { Q: 1, R: 2, B: 2, N: 2 },
      /** Допустимые значения `memorizeTimeSec` (UI-селект). */
      memorizeOptions: [3, 5, 10]
    };
    exports2.LEVEL_DURATION_PRESETS = [5, 10, 15, 20];
    exports2.DEFAULT_BLIND_BOARD_CONFIG = {
      startPieces: ["Q", "N", "R"],
      addOrder: ["B", "B", "R", "N"],
      memorizeTimeSec: 5,
      /** KS-3550. Текущее (V2) поведение level-up каждые 10 раундов. */
      levelDurationRounds: 10,
      /** KS-3550. По умолчанию прогрессия включена (legacy-режим). */
      progressionEnabled: true
    };
    function isDefaultBlindBoardConfig(config) {
      const d = exports2.DEFAULT_BLIND_BOARD_CONFIG;
      if (config.memorizeTimeSec !== d.memorizeTimeSec)
        return false;
      if (config.levelDurationRounds !== d.levelDurationRounds)
        return false;
      if (config.progressionEnabled !== d.progressionEnabled)
        return false;
      if (config.startPieces.length !== d.startPieces.length)
        return false;
      for (let i = 0; i < d.startPieces.length; i++) {
        if (config.startPieces[i] !== d.startPieces[i])
          return false;
      }
      if (config.addOrder.length !== d.addOrder.length)
        return false;
      for (let i = 0; i < d.addOrder.length; i++) {
        if (config.addOrder[i] !== d.addOrder[i])
          return false;
      }
      return true;
    }
    exports2.ALL_LECTURE_DISABLED_TOOLS = [
      "engine",
      "book",
      "ai_comment",
      "analyze_game",
      "generate_puzzle",
      "find_by_position",
      // KS-4051.
      "moves"
    ];
  }
});

// packages/shared/dist/types/feature-flags.js
var require_feature_flags = __commonJS({
  "packages/shared/dist/types/feature-flags.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/synthetic.js
var require_synthetic = __commonJS({
  "packages/shared/dist/types/synthetic.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.SYNTHETIC_BASE_CURVE_DEFAULT = exports2.SYNTHETIC_PLAY_STYLE_RATING_RANGE = exports2.SYNTHETIC_CONFIG_DEFAULTS = exports2.SyntheticEnvKey = void 0;
    exports2.isCountryCodeISO = isCountryCodeISO;
    exports2.syntheticHourBandOf = syntheticHourBandOf;
    exports2.syntheticDayKindOf = syntheticDayKindOf;
    exports2.syntheticBaseCurveAt = syntheticBaseCurveAt;
    exports2.syntheticAdaptedDesired = syntheticAdaptedDesired;
    exports2.SyntheticEnvKey = {
      /** Boolean. `'true'` → scheduler стартует на onModuleInit (KS-2164). */
      SchedulerEnabled: "SYNTHETIC_SCHEDULER_ENABLED",
      /** Int. Размер пула одновременных synthetic-сессий. */
      PoolSize: "SYNTHETIC_POOL_SIZE",
      /** Int. Лимит длины live-очереди, выше которого новые synthetic-партии не запускаются. */
      DisableAtLiveQueueLen: "SYNTHETIC_DISABLE_AT_LIVE_QUEUE_LEN",
      /** Int. Сколько партий нагенерить на cold-start (bootstrap-прогрев рейтингов). */
      BootstrapTargetGames: "SYNTHETIC_BOOTSTRAP_TARGET_GAMES",
      /** Cron string. Стартовый таймер-расписание. */
      ScheduleStart: "SYNTHETIC_SCHEDULE_START",
      /** Cron string. Расписание прайм-тайма (повышенный наплыв). */
      SchedulePeak: "SYNTHETIC_SCHEDULE_PEAK",
      /** Cron string. Расписание ночного режима (снижение активности). */
      ScheduleNight: "SYNTHETIC_SCHEDULE_NIGHT",
      /** Int. TTL Redis-сессии synthetic-юзера (presence) в секундах. */
      SessionTtlSec: "SYNTHETIC_SESSION_TTL_SEC",
      /** Int. Размер батча генерации профилей. */
      ProfileBatchSize: "SYNTHETIC_PROFILE_BATCH_SIZE",
      /** Int. Кол-во retry'ев на failed engine-tick. */
      EngineRetryAttempts: "SYNTHETIC_ENGINE_RETRY_ATTEMPTS",
      /** KS-2164. Int (ms). Период обновления `User.lastSeenAt` для онлайн-synthetic'ов. */
      PresenceTickMs: "SYNTHETIC_PRESENCE_TICK_MS",
      /** KS-2164. Int (ms). Минимальный интервал polling-pool joinQueue. */
      PollingIntervalMinMs: "SYNTHETIC_POLLING_INTERVAL_MIN_MS",
      /** KS-2164. Int (ms). Максимальный интервал polling-pool joinQueue. */
      PollingIntervalMaxMs: "SYNTHETIC_POLLING_INTERVAL_MAX_MS",
      /** KS-2164. Int (ms). Период scheduler-tick'а (рекомпиляция desired). */
      SchedulerTickMs: "SYNTHETIC_SCHEDULER_TICK_MS",
      /** KS-2164. JSON. Override базовой кривой (24×7×4); см. `BaseCurveSchedule`. */
      ScheduleOverrideJson: "SYNTHETIC_SCHEDULE_OVERRIDE_JSON",
      /** KS-2176 (KS-2163). Boolean. Главный фича-флаг bootstrap-сервиса. */
      BootstrapEnabled: "SYNTHETIC_BOOTSTRAP_ENABLED",
      /** KS-2176 (KS-2163). Boolean. TWIC opening book provider gate. */
      OpeningBookEnabled: "SYNTHETIC_OPENING_BOOK_ENABLED",
      /** KS-2176 (KS-2168). Boolean. Главный фича-флаг synthetic-чата. */
      ChatEnabled: "SYNTHETIC_CHAT_ENABLED"
    };
    exports2.SYNTHETIC_CONFIG_DEFAULTS = {
      schedulerEnabled: false,
      poolSize: 100,
      disableAtLiveQueueLen: 50,
      bootstrapTargetGames: 200,
      schedule: [],
      sessionTtlSec: 600,
      profileBatchSize: 20,
      engineRetryAttempts: 3
    };
    exports2.SYNTHETIC_PLAY_STYLE_RATING_RANGE = {
      beginner: { min: 800, max: 1200 },
      casual: { min: 1200, max: 1600 },
      competitive: { min: 1600, max: 1900 },
      expert: { min: 1900, max: 2200 }
    };
    function isCountryCodeISO(value) {
      return typeof value === "string" && value.length === 2 && /^[A-Z]{2}$/.test(value);
    }
    exports2.SYNTHETIC_BASE_CURVE_DEFAULT = {
      "00-05": {
        weekday: { bullet: 3, blitz: 3, rapid: 2, classical: 1 },
        weekend: { bullet: 5, blitz: 5, rapid: 2, classical: 1 }
      },
      "06-11": {
        weekday: { bullet: 5, blitz: 5, rapid: 3, classical: 1 },
        weekend: { bullet: 8, blitz: 8, rapid: 3, classical: 1 }
      },
      "12-17": {
        weekday: { bullet: 8, blitz: 8, rapid: 5, classical: 2 },
        weekend: { bullet: 15, blitz: 15, rapid: 5, classical: 2 }
      },
      "18-23": {
        weekday: { bullet: 15, blitz: 15, rapid: 8, classical: 3 },
        weekend: { bullet: 25, blitz: 25, rapid: 8, classical: 3 }
      }
    };
    function syntheticHourBandOf(hourUtc) {
      if (hourUtc < 6)
        return "00-05";
      if (hourUtc < 12)
        return "06-11";
      if (hourUtc < 18)
        return "12-17";
      return "18-23";
    }
    function syntheticDayKindOf(dayOfWeekUtc) {
      return dayOfWeekUtc === 0 || dayOfWeekUtc === 6 ? "weekend" : "weekday";
    }
    function syntheticBaseCurveAt(when, category, curve = exports2.SYNTHETIC_BASE_CURVE_DEFAULT) {
      const band = syntheticHourBandOf(when.getUTCHours());
      const kind = syntheticDayKindOf(when.getUTCDay());
      return curve[band][kind][category];
    }
    function syntheticAdaptedDesired(desired, liveInQueueAvg) {
      return Math.max(0, Math.round(desired - liveInQueueAvg * 2));
    }
  }
});

// packages/shared/dist/types/internal-auth.js
var require_internal_auth = __commonJS({
  "packages/shared/dist/types/internal-auth.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.INTERNAL_AUTH_HEADER = void 0;
    exports2.INTERNAL_AUTH_HEADER = "X-Internal-Auth";
  }
});

// packages/shared/dist/types/tactic-drill.js
var require_tactic_drill = __commonJS({
  "packages/shared/dist/types/tactic-drill.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DAILY_DRILL_DIFFICULTY_BY_WEEKDAY = exports2.DRILL_DIFFICULTY_LABEL = exports2.DRILL_HINT = exports2.DRILL_INSTRUCTION = exports2.DRILL_TYPE_LABEL = exports2.DRILL_TYPE_ANSWER_SHAPE = exports2.DRILL_TYPE_ORDER = exports2.DRILL_TYPE_LAYER = void 0;
    exports2.DRILL_TYPE_LAYER = {
      "count-attackers": "overview",
      "find-loose-piece": "overview",
      "find-hanging-piece": "overview",
      "find-all-checks": "pattern",
      "find-pin": "pattern",
      "find-fork": "pattern",
      "find-undefended-attack": "calculation"
    };
    exports2.DRILL_TYPE_ORDER = [
      "count-attackers",
      "find-loose-piece",
      "find-hanging-piece",
      "find-all-checks",
      "find-pin",
      "find-fork",
      "find-undefended-attack"
    ];
    exports2.DRILL_TYPE_ANSWER_SHAPE = {
      // KS-2335 (после KS-2337 backend): find-hanging-piece переведён с
      // 'square' на 'move' — drill теперь требует «возьми незащищённую
      // фигуру одним ходом», ответ {from, to}. Strict-uniqueness по паре
      // (from, to). См. docs/architecture/KS-2335-find-hanging-piece-move-shape.md.
      "find-hanging-piece": "move",
      "find-loose-piece": "square",
      "find-pin": "square",
      // KS-2400: find-fork переведён с 'square' (укажи фигуру-вилку,
      // которая уже стоит) на 'move' (сделай ход, создающий новую
      // вилку). Snapshot before/after, см. predicate find-fork.ts.
      "find-fork": "move",
      "count-attackers": "number",
      "find-all-checks": "squares",
      "find-undefended-attack": "move"
    };
    exports2.DRILL_TYPE_LABEL = {
      "find-hanging-piece": { ru: "\u0417\u0430\u0432\u0438\u0441\u0448\u0430\u044F \u0444\u0438\u0433\u0443\u0440\u0430", en: "Hanging piece" },
      "find-loose-piece": { ru: "\u0421\u043B\u0430\u0431\u043E \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u0430\u044F", en: "Loose piece" },
      "find-pin": { ru: "\u0421\u0432\u044F\u0437\u043A\u0430", en: "Pin" },
      "find-fork": { ru: "\u0412\u0438\u043B\u043A\u0430", en: "Fork" },
      "count-attackers": { ru: "\u0421\u043E\u0441\u0447\u0438\u0442\u0430\u0442\u044C \u0430\u0442\u0430\u043A\u0443\u044E\u0449\u0438\u0445", en: "Count attackers" },
      "find-all-checks": { ru: "\u0412\u0441\u0435 \u0448\u0430\u0445\u0438", en: "All checks" },
      "find-undefended-attack": { ru: "\u0411\u0435\u0437\u043E\u0442\u0432\u0435\u0442\u043D\u0430\u044F \u0430\u0442\u0430\u043A\u0430", en: "Undefended attack" }
    };
    exports2.DRILL_INSTRUCTION = {
      "find-hanging-piece": {
        // KS-2335: drill теперь требует ход-взятие, а не клик клетки.
        ru: "\u0412\u043E\u0437\u044C\u043C\u0438 \u0445\u043E\u0434\u043E\u043C \u0444\u0438\u0433\u0443\u0440\u0443 \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430 \u0431\u0435\u0437 \u0437\u0430\u0449\u0438\u0442\u043D\u0438\u043A\u043E\u0432.",
        en: "Capture an undefended enemy piece in one move."
      },
      "find-loose-piece": {
        ru: "\u041D\u0430\u0439\u0434\u0438 \u0444\u0438\u0433\u0443\u0440\u0443 \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430, \u0443 \u043A\u043E\u0442\u043E\u0440\u043E\u0439 \u043D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0437\u0430\u0449\u0438\u0442\u043D\u0438\u043A\u0430.",
        en: "Find an opponent's piece without any defenders."
      },
      "find-pin": {
        ru: "\u041D\u0430\u0439\u0434\u0438 \u0441\u0432\u044F\u0437\u0430\u043D\u043D\u0443\u044E \u0444\u0438\u0433\u0443\u0440\u0443 \u2014 \u0442\u0443, \u043A\u043E\u0442\u043E\u0440\u0430\u044F \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0443\u0439\u0442\u0438 \u0438\u0437-\u0437\u0430 \u0431\u043E\u043B\u0435\u0435 \u0446\u0435\u043D\u043D\u043E\u0439 \u0437\u0430 \u043D\u0435\u0439.",
        en: "Find the pinned piece \u2014 it can't move because of a more valuable piece behind it."
      },
      "find-fork": {
        // KS-2400: формулировка под shape='move' (создай новую вилку).
        ru: "\u0421\u0434\u0435\u043B\u0430\u0439 \u0445\u043E\u0434, \u043F\u043E\u0441\u043B\u0435 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u0442\u0432\u043E\u044F \u0444\u0438\u0433\u0443\u0440\u0430 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u0430\u0442\u0430\u043A\u0443\u0435\u0442 \u22652 \u0446\u0435\u043D\u043D\u044B\u0445 \u0444\u0438\u0433\u0443\u0440 \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430.",
        en: "Make a move that creates a fork \u2014 your piece attacking \u22652 valuable enemy pieces."
      },
      "count-attackers": {
        ru: "\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0444\u0438\u0433\u0443\u0440 \u0437\u0430\u0434\u0430\u043D\u043D\u043E\u0433\u043E \u0446\u0432\u0435\u0442\u0430 \u0430\u0442\u0430\u043A\u0443\u044E\u0442 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u0443\u044E \u043A\u043B\u0435\u0442\u043A\u0443?",
        en: "How many pieces of the specified color attack the highlighted square?"
      },
      "find-all-checks": {
        ru: "\u041E\u0442\u043C\u0435\u0442\u044C \u0412\u0421\u0415 \u043A\u043B\u0435\u0442\u043A\u0438 \xABto\xBB, \u0445\u043E\u0434 \u043D\u0430 \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0434\u0430\u0451\u0442 \u0448\u0430\u0445.",
        en: "Mark ALL destination squares where a move gives check."
      },
      "find-undefended-attack": {
        ru: "\u041D\u0430\u0439\u0434\u0438 \u0445\u043E\u0434, \u043F\u043E\u0441\u043B\u0435 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u0442\u044B \u0430\u0442\u0430\u043A\u0443\u0435\u0448\u044C \u0431\u0435\u0437\u0437\u0430\u0449\u0438\u0442\u043D\u0443\u044E \u0444\u0438\u0433\u0443\u0440\u0443 \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430.",
        en: "Find the move that creates an attack on an undefended enemy piece."
      }
    };
    exports2.DRILL_HINT = {
      "find-hanging-piece": {
        // KS-2335: подсказка дополнена призывом «возьми её».
        ru: "\u0417\u0430\u0432\u0438\u0441\u0448\u0430\u044F = \u043F\u043E\u0434 \u0431\u043E\u0435\u043C \u0418 \u0431\u0435\u0437 \u0437\u0430\u0449\u0438\u0442\u043D\u0438\u043A\u043E\u0432. \u0412\u043E\u0437\u044C\u043C\u0438 \u0435\u0451.",
        en: "Hanging = attacked AND undefended. Take it."
      },
      "find-loose-piece": {
        ru: "\u0421\u043B\u0430\u0431\u0430\u044F = \u0431\u0435\u0437 \u0437\u0430\u0449\u0438\u0442\u043D\u0438\u043A\u043E\u0432. \u041F\u043E\u0434 \u0431\u043E\u0435\u043C \u043D\u0435 \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E.",
        en: "Loose = no defenders. Attack not required."
      },
      "find-pin": {
        ru: "\u0417\u0430 \u0441\u0432\u044F\u0437\u0430\u043D\u043D\u043E\u0439 \u0444\u0438\u0433\u0443\u0440\u043E\u0439 \u0441\u0442\u043E\u0438\u0442 \u0431\u043E\u043B\u0435\u0435 \u0446\u0435\u043D\u043D\u0430\u044F \u043F\u043E \u0442\u043E\u0439 \u0436\u0435 \u043B\u0438\u043D\u0438\u0438.",
        en: "Behind the pinned piece sits a more valuable one on the same line."
      },
      "find-fork": {
        // KS-2400: подсказка обновлена — drill теперь требует ход.
        ru: "\u041E\u0434\u0438\u043D \u0445\u043E\u0434 \u2014 \u0442\u0432\u043E\u044F \u0444\u0438\u0433\u0443\u0440\u0430 \u0430\u0442\u0430\u043A\u0443\u0435\u0442 \u0434\u0432\u0435 \u0446\u0435\u043B\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0434\u043E \u044D\u0442\u043E\u0433\u043E \u0431\u044B\u043B\u0438 \u0432\u043D\u0435 \u0443\u0434\u0430\u0440\u0430.",
        en: "One move \u2014 your piece attacks two targets that were not under attack before."
      },
      "count-attackers": {
        ru: "\u0423\u0447\u0442\u0438 \u0432\u0441\u0435 \xAB\u0431\u0430\u0442\u0430\u0440\u0435\u0438\xBB \u043F\u043E \u043B\u0438\u043D\u0438\u0438.",
        en: "Count all batteries along the line."
      },
      "find-all-checks": {
        ru: "\u041D\u0435 \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438 \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u0439 \u0448\u0430\u0445.",
        en: "Don't miss discovered checks."
      },
      "find-undefended-attack": {
        ru: "\u0426\u0435\u043B\u044C \u2014 \u0444\u0438\u0433\u0443\u0440\u0430 \u0431\u0435\u0437 \u0437\u0430\u0449\u0438\u0442\u043D\u0438\u043A\u043E\u0432.",
        en: "Target \u2014 a piece with no defenders."
      }
    };
    exports2.DRILL_DIFFICULTY_LABEL = {
      easy: { ru: "\u041B\u0451\u0433\u043A\u0430\u044F", en: "Easy" },
      medium: { ru: "\u0421\u0440\u0435\u0434\u043D\u044F\u044F", en: "Medium" },
      hard: { ru: "\u0421\u043B\u043E\u0436\u043D\u0430\u044F", en: "Hard" }
    };
    exports2.DAILY_DRILL_DIFFICULTY_BY_WEEKDAY = {
      0: "hard",
      // Воскресенье
      1: "easy",
      // Понедельник
      2: "easy",
      // Вторник
      3: "medium",
      // Среда
      4: "easy",
      // Четверг
      5: "medium",
      // Пятница
      6: "hard"
      // Суббота
    };
  }
});

// packages/shared/dist/types/tactic-puzzle.js
var require_tactic_puzzle = __commonJS({
  "packages/shared/dist/types/tactic-puzzle.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/blog.js
var require_blog = __commonJS({
  "packages/shared/dist/types/blog.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/saved-filters.js
var require_saved_filters = __commonJS({
  "packages/shared/dist/types/saved-filters.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/opening-trainer.js
var require_opening_trainer = __commonJS({
  "packages/shared/dist/types/opening-trainer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.OPENING_LINE_MASTERY_THRESHOLD = exports2.OPENING_TRAINER_SCORING = exports2.OPENING_REPERTOIRE_LIMITS = void 0;
    exports2.isCorrectMove = isCorrectMove;
    exports2.isWrongMove = isWrongMove;
    exports2.isLineCompleteMove = isLineCompleteMove;
    exports2.isLineRestartMove = isLineRestartMove;
    exports2.isTreeCompleteMove = isTreeCompleteMove;
    exports2.OPENING_REPERTOIRE_LIMITS = {
      /** Максимум уникальных позиций (FEN'ов после транспозиций). */
      maxNodes: 2e3,
      /** Максимум edges (вариантов; одна позиция может иметь несколько). */
      maxEdges: 5e3,
      /**
       * KS-3335: лимит глубины снят. Раньше был 80 полуходов (= 40 ходов),
       * чтобы ограничивать только дебютной теорией. Пользователи добавляют
       * полные партии (включая миттельшпиль/эндшпиль) — глубина > 80 ходов
       * штатная. nodeCount/edgeCount/pgnBytes продолжают защищать от
       * патологических объёмов.
       */
      /** Максимум размер исходного PGN в байтах. */
      maxPgnBytes: 500 * 1024,
      /** Максимум репертуаров на пользователя (MVP). */
      maxRepertoiresPerUser: 50,
      /** Максимум активных (незакрытых) сессий на пользователя. */
      maxActiveSessionsPerUser: 10,
      /**
       * KS-3324 / ADR-078. Максимум источников (PGN-блоков) в одном
       * репертуаре. Превышение → 400/409 при `POST /repertoires` или
       * `POST /repertoires/:id/sources`.
       */
      maxSourcesPerRepertoire: 20
    };
    exports2.OPENING_TRAINER_SCORING = {
      /** Правильный ход без подсказки. */
      correctNoHint: 10,
      /** Правильный ход после `hint`. */
      correctWithHint: 5,
      /** Бонус за быстрый правильный ход (< 5 секунд от показа позиции). */
      fastBonusMs: 5e3,
      fastBonusPoints: 1,
      /** Неправильный ход (минимум баланс 0 — не уходим в минус). */
      wrong: -5,
      /** Streak triggers at this count of consecutive correct moves. */
      streakThreshold: 5,
      /** Multiplier для streak-бонуса, применяется до первой ошибки. */
      streakMultiplier: 1.2
    };
    exports2.OPENING_LINE_MASTERY_THRESHOLD = 3;
    function isCorrectMove(r) {
      return r.result === "correct";
    }
    function isWrongMove(r) {
      return r.result === "wrong";
    }
    function isLineCompleteMove(r) {
      return r.result === "line-complete";
    }
    function isLineRestartMove(r) {
      return r.result === "line-restart";
    }
    function isTreeCompleteMove(r) {
      return r.result === "tree-complete";
    }
  }
});

// packages/shared/dist/types/live-analysis.js
var require_live_analysis = __commonJS({
  "packages/shared/dist/types/live-analysis.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LiveAnalysisEvents = void 0;
    exports2.LiveAnalysisEvents = {
      /** Namespace path, передаётся в `io(<base>, { path: '/socket.io' })` через `Server`/`Namespace` ctor. */
      NAMESPACE: "/live-analysis",
      // client → server
      SUBSCRIBE: "live-analysis:subscribe",
      UNSUBSCRIBE: "live-analysis:unsubscribe",
      MOVE: "live-analysis:move",
      RESET: "live-analysis:reset",
      CLOSE: "live-analysis:close",
      SYNC_REQUEST: "live-analysis:sync",
      /**
       * KS-3742 / ADR-111 §2.2. Автор обновил содержимое окна анализа
       * (дерево вариантов, NAGs, комментарии, аннотации, headers,
       * orientation). Payload — `LiveAnalysisStatePatchPayload`. Owner-only,
       * с дебаунсом 500 мс на стороне клиента и серверным дросселированием
       * приёма 5/сек burst 10.
       */
      STATE_PATCH: "live-analysis:state-patch",
      // server → client
      // NB: `MOVE` и `SYNC_REQUEST` — одно имя для client→server и server→client
      // ходов / sync-запроса и sync-ответа соответственно. Socket.io это
      // допускает (разные направления — разные обработчики).
      SYNC: "live-analysis:sync",
      VIEWERS: "live-analysis:viewers",
      CLOSED: "live-analysis:closed",
      ERROR: "live-analysis:error",
      /**
       * KS-3896 / ADR-117 §3. Тренер изменил `Lecture.disabledTools` —
       * сервер шлёт `LectureToolsChangedEvent` всем подписчикам
       * live-сессии (учеников). Полный новый набор, не дельта. Для
       * трансляций без привязки к лекции событие не эмитится.
       */
      LECTURE_TOOLS: "live-analysis:lecture-tools",
      /**
       * KS-3946 / ADR-118 §2.4.2. Сервер отказал в `subscribe`-handshake
       * к комнате live-сессии restricted-лекции. Эмитится клиенту до
       * `join room`, после чего сокет отключается. Payload — закрытый
       * union `{ reason: 'auth_required' | 'not_in_allowlist' }`, фронт
       * мапит на UX-страницы «войти» / «доступ закрыт».
       */
      ACCESS_DENIED: "live-analysis:access-denied",
      /**
       * KS-3946 / ADR-118 §2.4.2. Сервер отзывает доступ у уже
       * подключённого зрителя — тренер снял grant (`reason: 'revoked'`)
       * или сменил visibility на `restricted` с пустым allowlist'ом
       * (`reason: 'visibility-changed'`). Payload —
       * `LiveAnalysisAccessRevokedPayload` (см. api-contracts).
       */
      ACCESS_REVOKED: "live-analysis:access-revoked",
      /**
       * KS-4627 / ADR-142 §2.7. Сервер сообщает всем зрителям комнаты,
       * что тренер переключил активное окно анализа. Payload —
       * `LiveAnalysisAnalysisSwitchEvent`. Эмитится как побочный эффект
       * `POST /live-analyses/:slug/switch-analysis`; параллельно сервер
       * шлёт обычный `SYNC` snapshot, расширенный полями `activeAnalysisId`/
       * `activeTitle` — для backward-compat с клиентами, не знающими нового
       * события.
       */
      ANALYSIS_SWITCH: "live-analysis:analysis-switch"
    };
  }
});

// packages/shared/dist/types/lecture-chat.js
var require_lecture_chat = __commonJS({
  "packages/shared/dist/types/lecture-chat.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LECTURE_CHAT_LIMITS = exports2.LectureChatEvents = void 0;
    exports2.LectureChatEvents = {
      // client → server
      SEND: "chat:send",
      DELETE: "chat:delete",
      MUTE: "chat:mute",
      // server → client
      MESSAGE: "chat:message",
      SNAPSHOT: "chat:snapshot",
      DELETED: "chat:delete",
      MUTED: "chat:muted",
      ERROR: "chat:error"
    };
    exports2.LECTURE_CHAT_LIMITS = {
      /** Максимум unicode-codepoints в одном сообщении после trim. */
      MAX_TEXT_LENGTH: 500,
      /** Sliding window: сколько сообщений за окно. */
      RATE_LIMIT_WINDOW_COUNT: 3,
      /** Sliding window: длина окна, мс. */
      RATE_LIMIT_WINDOW_MS: 1e4,
      /** Duplicate guard: TTL хеша последнего сообщения автора, сек. */
      DUPLICATE_TTL_SEC: 30,
      /** Сколько последних сообщений отдаём в `chat:snapshot`. */
      SNAPSHOT_LIMIT: 100
    };
  }
});

// packages/shared/dist/types/positional-trace.js
var require_positional_trace = __commonJS({
  "packages/shared/dist/types/positional-trace.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.POSITIONAL_TRACE_VALUE_LIMIT = exports2.POSITIONAL_TRACE_MAX_BODY_BYTES = exports2.POSITIONAL_TRACE_VERSION = void 0;
    exports2.POSITIONAL_TRACE_VERSION = "sf18-trace-v2";
    exports2.POSITIONAL_TRACE_MAX_BODY_BYTES = 256 * 1024;
    exports2.POSITIONAL_TRACE_VALUE_LIMIT = 20;
  }
});

// packages/shared/dist/review/metrics-comment.js
var require_metrics_comment = __commonJS({
  "packages/shared/dist/review/metrics-comment.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WHITE_SIGNED_IDS = exports2.METRIC_BLOCKS = exports2.LLM_BLOCK_KEYS = void 0;
    exports2.computePhaseFromFen = computePhaseFromFen;
    exports2.pickValueWithPhase = pickValueWithPhase;
    exports2.buildMetricsCommentRequest = buildMetricsCommentRequest;
    exports2.LLM_BLOCK_KEYS = [
      "material",
      "pawn_structure",
      "king_safety",
      "pieces",
      "mobility",
      "threats",
      "passed_pawns"
    ];
    exports2.METRIC_BLOCKS = {
      material: ["material", "imbalance"],
      pawn_structure: [
        "pawn_connected",
        "pawn_isolated",
        "pawn_doubled",
        "pawn_backward",
        "pawn_lever_double",
        "pawn_blocked",
        "pawn_doubled_early"
      ],
      // 8 id, без `king_attackers_*` и `king_safe_check_*` — эти живут в
      // штрафной шкале SafeCheck/AttackersWeight и попадают в cp только
      // через нелинейную свёртку kingDanger. Включить их сюда — дать
      // двойной учёт.
      king_safety: [
        "king_danger",
        "king_safety_pawn",
        "king_shelter_strength",
        "king_blocked_storm",
        "king_unblocked_storm",
        "king_on_file",
        "king_pawnless_flank",
        "king_flank_attacks"
      ],
      pieces: [
        "rook_on_open_file",
        "rook_on_closed_file",
        "rook_trapped",
        "rook_on_king_ring",
        "bishop_on_king_ring",
        "bishop_long_diagonal",
        "bishop_pawns",
        "bishop_xray_pawns",
        "bishop_cornered",
        "outpost_knight",
        "outpost_bishop",
        "knight_uncontested_outpost",
        "knight_reachable_outpost",
        "minor_behind_pawn",
        "knight_king_protector_distance",
        "bishop_king_protector_distance",
        "queen_weak"
      ],
      mobility: [
        "mobility_knight",
        "mobility_bishop",
        "mobility_rook",
        "mobility_queen"
      ],
      threats: [
        "threat_by_minor",
        "threat_by_rook",
        "threat_by_king",
        "threat_hanging",
        "threat_weak_queen_protection",
        "threat_restricted_piece",
        "threat_by_safe_pawn",
        "threat_by_pawn_push",
        "threat_knight_on_queen",
        "threat_slider_on_queen"
      ],
      passed_pawns: [
        "passed_rank",
        "passed_king_proximity",
        "passed_path_advance",
        "passed_file_edge"
      ]
    };
    exports2.WHITE_SIGNED_IDS = /* @__PURE__ */ new Set([
      "psqt_pawn",
      "psqt_knight",
      "psqt_bishop",
      "psqt_rook",
      "psqt_queen",
      "psqt_king",
      "material",
      "imbalance"
    ]);
    function computePhaseFromFen(fen) {
      if (typeof fen !== "string" || fen.length === 0)
        return 128;
      const board = (fen.split(" ")[0] ?? "").toLowerCase();
      let phaseValue = 0;
      for (const ch of board) {
        if (ch === "n" || ch === "b")
          phaseValue += 1;
        else if (ch === "r")
          phaseValue += 2;
        else if (ch === "q")
          phaseValue += 4;
      }
      const NPM_MAX = 24;
      const clipped = Math.min(NPM_MAX, phaseValue);
      return Math.round(clipped * 256 / NPM_MAX);
    }
    function pickValueWithPhase(subterm, phase) {
      const mgRaw = subterm.value_mg ?? 0;
      const egRaw = subterm.value_eg ?? 0;
      if (!Number.isFinite(mgRaw) || !Number.isFinite(egRaw))
        return 0;
      return (mgRaw * phase + egRaw * (256 - phase)) / 256;
    }
    function buildIdToBlock() {
      const out = /* @__PURE__ */ new Map();
      for (const block of exports2.LLM_BLOCK_KEYS) {
        for (const id of exports2.METRIC_BLOCKS[block])
          out.set(id, block);
      }
      return out;
    }
    var ID_TO_BLOCK = buildIdToBlock();
    function round3(x) {
      return Math.round(x * 1e3) / 1e3;
    }
    function buildMetricsCommentRequest(subterms, options) {
      const phase = options.phase ?? (options.fen !== void 0 ? computePhaseFromFen(options.fen) : void 0);
      if (phase === void 0) {
        throw new TypeError("buildMetricsCommentRequest: need either options.fen or options.phase");
      }
      const acc = {
        material: 0,
        pawn_structure: 0,
        king_safety: 0,
        pieces: 0,
        mobility: 0,
        threats: 0,
        passed_pawns: 0
      };
      for (const s of subterms) {
        const block = ID_TO_BLOCK.get(s.id);
        if (!block)
          continue;
        const tapered = pickValueWithPhase(s, phase);
        const sign = exports2.WHITE_SIGNED_IDS.has(s.id) ? 1 : s.color === "b" ? -1 : 1;
        acc[block] += sign * tapered;
      }
      const metrics = {};
      for (const k of exports2.LLM_BLOCK_KEYS) {
        metrics[k] = { value_cp: round3(acc[k]) };
      }
      return { metrics, phase };
    }
  }
});

// packages/shared/dist/types/prerender-task.js
var require_prerender_task = __commonJS({
  "packages/shared/dist/types/prerender-task.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.resolvePrerenderRoute = resolvePrerenderRoute;
    exports2.isPrerenderTask = isPrerenderTask;
    function resolvePrerenderRoute(task, baseUrl) {
      const base = baseUrl.replace(/\/+$/, "");
      switch (task.kind) {
        case "broadcast": {
          const path = ["/broadcasts", task.tid, task.rid, task.gid].filter((p) => Boolean(p)).join("/");
          const keyParts = [task.tid, task.rid, task.gid].filter((p) => Boolean(p));
          return {
            url: `${base}${path}`,
            s3Key: `broadcasts/${keyParts.join("/")}.html`
          };
        }
        case "tournament":
          return {
            url: `${base}/tournaments/${task.id}`,
            s3Key: `tournaments/${task.id}.html`
          };
        case "coach":
          return {
            url: `${base}/coach/${task.username}`,
            s3Key: `coach/${task.username}.html`
          };
        case "lecture":
          return {
            url: `${base}/lectures/${task.id}`,
            s3Key: `lectures/${task.id}.html`
          };
        case "player":
          return {
            url: `${base}/player/${task.username}`,
            s3Key: `player/${task.username}.html`
          };
        case "archive-game":
          return {
            url: `${base}/archive/games/${task.id}`,
            s3Key: `archive/games/${task.id}.html`
          };
        case "archive-player":
          return {
            url: `${base}/archive/players/${task.slug}`,
            s3Key: `archive/players/${task.slug}.html`
          };
        case "analysis-public":
          return {
            url: `${base}/analysis/public/${task.id}`,
            s3Key: `analysis/public/${task.id}.html`
          };
        case "blog-post":
          return {
            url: `${base}/${task.locale}/blog/${task.slug}`,
            s3Key: `${task.locale}/blog/${task.slug}.html`,
            readySelector: 'meta[property="og:type"][content="article"], [data-testid="blog-post-not-found"]'
          };
        case "list": {
          const slug = task.route.replace(/^\//, "");
          return { url: `${base}${task.route}`, s3Key: `list/${slug}.html` };
        }
        default: {
          const exhaustive = task;
          throw new Error(`Unknown PrerenderTask: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    function isPrerenderTask(value) {
      if (!value || typeof value !== "object")
        return false;
      const v = value;
      const isStr = (x) => typeof x === "string" && x.length > 0;
      switch (v.kind) {
        case "broadcast":
          return isStr(v.tid) && (v.rid === void 0 || isStr(v.rid)) && (v.gid === void 0 || isStr(v.gid));
        case "tournament":
        case "lecture":
        case "archive-game":
        case "analysis-public":
          return isStr(v.id);
        case "coach":
        case "player":
          return isStr(v.username);
        case "archive-player":
          return isStr(v.slug);
        case "blog-post":
          return (v.locale === "ru" || v.locale === "en") && isStr(v.slug);
        case "list":
          return v.route === "/broadcasts" || v.route === "/tournaments" || v.route === "/lectures" || v.route === "/players" || v.route === "/archive";
        default:
          return false;
      }
    }
  }
});

// packages/shared/dist/types/lecture-replay.js
var require_lecture_replay = __commonJS({
  "packages/shared/dist/types/lecture-replay.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.serializeMoveKey = serializeMoveKey;
    exports2.parseMoveKey = parseMoveKey;
    function serializeMoveKey(k) {
      return `${k.segment}:${k.globalIndex}`;
    }
    function parseMoveKey(s) {
      const [seg, idx] = s.split(":");
      return { segment: Number(seg), globalIndex: Number(idx) };
    }
  }
});

// packages/shared/dist/utils/lecture-replay/buildMoveTimestampIndex.js
var require_buildMoveTimestampIndex = __commonJS({
  "packages/shared/dist/utils/lecture-replay/buildMoveTimestampIndex.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.buildMoveTimestampIndex = buildMoveTimestampIndex;
    var lecture_replay_js_1 = require_lecture_replay();
    function closeVisit(state, atMs) {
      if (state.currentGlobalIndex === null || state.visitStartedAtMs === null) {
        state.currentGlobalIndex = null;
        state.visitStartedAtMs = null;
        return;
      }
      const key = {
        segment: state.segment,
        globalIndex: state.currentGlobalIndex
      };
      const enteredAtMs = state.visitStartedAtMs;
      const endedAtMs = atMs;
      const durationMs = endedAtMs - enteredAtMs;
      const visit = { enteredAtMs, endedAtMs, durationMs };
      const serialized = (0, lecture_replay_js_1.serializeMoveKey)(key);
      let arr = state.visits.get(serialized);
      if (!arr) {
        arr = [];
        state.visits.set(serialized, arr);
      }
      arr.push(visit);
      state.currentGlobalIndex = null;
      state.visitStartedAtMs = null;
    }
    function closeSegment(state, atMs, openNextWithTitle) {
      closeVisit(state, atMs);
      state.segmentBoundaries[state.segment].endedAtMs = atMs;
      state.segment += 1;
      state.segmentBoundaries.push({
        segment: state.segment,
        startedAtMs: atMs,
        endedAtMs: null,
        title: openNextWithTitle
      });
    }
    function buildMoveTimestampIndex(events, totalDurationMs) {
      const state = {
        segment: 0,
        currentGlobalIndex: null,
        visitStartedAtMs: null,
        visits: /* @__PURE__ */ new Map(),
        segmentBoundaries: [
          { segment: 0, startedAtMs: 0, endedAtMs: null, title: null }
        ]
      };
      let prevT = 0;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (typeof event.t !== "number" || event.t < prevT) {
          throw new Error(`buildMoveTimestampIndex: events out of order at index ${i} (t=${event.t}, prevT=${prevT})`);
        }
        prevT = event.t;
        switch (event.type) {
          case "analysis-switch": {
            const isSynthetic = event.t === 0 && state.segment === 0 && state.currentGlobalIndex === null && state.visits.size === 0;
            if (isSynthetic) {
              state.segmentBoundaries[0].title = event.payload.title;
            } else {
              closeSegment(state, event.t, event.payload.title);
            }
            break;
          }
          case "reset": {
            closeSegment(state, event.t, null);
            break;
          }
          case "state-patch": {
            const cgi = event.payload.currentGlobalIndex;
            if (cgi === void 0) {
              break;
            }
            if (cgi !== state.currentGlobalIndex) {
              closeVisit(state, event.t);
              state.currentGlobalIndex = cgi;
              state.visitStartedAtMs = event.t;
            }
            break;
          }
          case "move": {
            break;
          }
          case "closed": {
            closeSegment(state, event.t, null);
            break;
          }
          default: {
            const _exhaustive = event;
            void _exhaustive;
          }
        }
      }
      if (state.currentGlobalIndex !== null) {
        closeVisit(state, totalDurationMs);
      }
      const lastBoundary = state.segmentBoundaries[state.segmentBoundaries.length - 1];
      if (lastBoundary.endedAtMs === null) {
        lastBoundary.endedAtMs = totalDurationMs;
      }
      if (state.segmentBoundaries.length > 1 && state.segmentBoundaries[state.segmentBoundaries.length - 1].startedAtMs === state.segmentBoundaries[state.segmentBoundaries.length - 1].endedAtMs) {
        state.segmentBoundaries.pop();
      }
      return {
        visits: state.visits,
        segmentBoundaries: state.segmentBoundaries,
        totalDurationMs
      };
    }
  }
});

// packages/shared/dist/synthetic-chat-phrases.js
var require_synthetic_chat_phrases = __commonJS({
  "packages/shared/dist/synthetic-chat-phrases.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.RUSSIAN_COUNTRY_CODES = exports2.SYNTHETIC_CHAT_DEFAULTS = exports2.SPONTANEOUS_CLOSING_PHRASES = exports2.SPONTANEOUS_OPENING_PHRASES = exports2.DEFAULT_TRIGGER_RULES = void 0;
    exports2.looksLikeRussianText = looksLikeRussianText;
    exports2.preferredLang = preferredLang;
    exports2.matchTriggerRule = matchTriggerRule;
    exports2.pickReplyForLang = pickReplyForLang;
    exports2.DEFAULT_TRIGGER_RULES = [
      // Greetings
      {
        triggers: ["hi", "hello", "hey", "\u043F\u0440\u0438\u0432\u0435\u0442"],
        replies: [
          { text: "hi", lang: "en" },
          { text: "hello", lang: "en" },
          { text: "hey there", lang: "en" },
          { text: "\u043F\u0440\u0438\u0432\u0435\u0442", lang: "ru" }
        ],
        delayMinMs: 200,
        delayMaxMs: 800
      },
      // gl/hf
      {
        triggers: ["glhf", "hf", "gl "],
        replies: [
          { text: "glhf", lang: "en" },
          { text: "gl", lang: "en" },
          { text: "hf", lang: "en" }
        ],
        delayMinMs: 200,
        delayMaxMs: 800
      },
      // gg/wp/nice
      {
        triggers: ["gg", "wp", "nice"],
        replies: [
          { text: "gg", lang: "en" },
          { text: "wp", lang: "en" },
          { text: "thx", lang: "en" }
        ],
        delayMinMs: 200,
        delayMaxMs: 800
      },
      // thanks
      {
        triggers: ["thanks", "thx", "\u0441\u043F\u0430\u0441\u0438\u0431\u043E"],
        replies: [
          { text: "np", lang: "en" },
          { text: "welcome", lang: "en" },
          { text: "\u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430", lang: "ru" }
        ],
        delayMinMs: 200,
        delayMaxMs: 800
      },
      // oops/blunder/noo — только в активной партии
      {
        triggers: ["oops", "blunder", "noo"],
        replies: [
          { text: ":(", lang: "en" },
          { text: "lol", lang: "en" },
          { text: "oof", lang: "en" }
        ],
        applicableAfterEnd: false,
        delayMinMs: 200,
        delayMaxMs: 800
      }
    ];
    exports2.SPONTANEOUS_OPENING_PHRASES = [
      { text: "glhf", lang: "en" },
      { text: "gl", lang: "en" },
      { text: "hf", lang: "en" },
      { text: "hi", lang: "en" },
      { text: "\u043F\u0440\u0438\u0432\u0435\u0442", lang: "ru" }
    ];
    exports2.SPONTANEOUS_CLOSING_PHRASES = [
      { text: "gg", lang: "en" },
      { text: "wp", lang: "en" },
      { text: "thx", lang: "en" },
      { text: "\u0441\u043F\u0430\u0441\u0438\u0431\u043E", lang: "ru" },
      { text: "\u0445\u043E\u0440\u043E\u0448\u0430\u044F \u043F\u0430\u0440\u0442\u0438\u044F", lang: "ru" }
    ];
    exports2.SYNTHETIC_CHAT_DEFAULTS = {
      /** Cooldown между двумя сообщениями synthetic'а в одной партии. */
      cooldownMs: 6e4,
      /** Cap сообщений synthetic'а за партию. */
      perGameCap: 5,
      /** Спонтанная фраза в начале — вероятность. */
      spontaneousOpeningProb: 0.1,
      /** Задержка спонтанной opening-фразы. */
      spontaneousOpeningDelayMinMs: 500,
      spontaneousOpeningDelayMaxMs: 2e3,
      /** Спонтанная фраза в конце — вероятность. */
      spontaneousClosingProb: 0.5,
      spontaneousClosingDelayMinMs: 1e3,
      spontaneousClosingDelayMaxMs: 3e3
    };
    exports2.RUSSIAN_COUNTRY_CODES = /* @__PURE__ */ new Set(["RU", "UA"]);
    var CYRILLIC_RE = /[Ѐ-ӿ]/;
    function looksLikeRussianText(text) {
      return CYRILLIC_RE.test(text);
    }
    function preferredLang(syntheticCountry, incomingText) {
      if (syntheticCountry && exports2.RUSSIAN_COUNTRY_CODES.has(syntheticCountry.toUpperCase()) && looksLikeRussianText(incomingText)) {
        return "ru";
      }
      return "en";
    }
    function matchTriggerRule(text, rules = exports2.DEFAULT_TRIGGER_RULES, isAfterEnd = false) {
      const normalized = text.toLowerCase();
      for (const rule of rules) {
        if (isAfterEnd && rule.applicableAfterEnd === false)
          continue;
        for (const trigger of rule.triggers) {
          if (normalized.includes(trigger.toLowerCase()))
            return rule;
        }
      }
      return null;
    }
    function pickReplyForLang(rule, lang, rng = Math.random) {
      const matching = rule.replies.filter((r) => r.lang === lang);
      const pool = matching.length > 0 ? matching : rule.replies;
      return pool[Math.floor(rng() * pool.length)].text;
    }
  }
});

// packages/shared/dist/constants.js
var require_constants = __commonJS({
  "packages/shared/dist/constants.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.USER_LESSON_COMPLETION_THRESHOLD = exports2.PIECE_SETS = exports2.BOARD_THEMES = exports2.MAX_INCREMENT_SEC = exports2.MAX_INITIAL_TIME_SEC = exports2.DAILY_TIME_CONTROLS = exports2.MATCHMAKING_BOTS = exports2.MAX_ACTIVE_BOT_GAMES = exports2.DEV_USERNAME = exports2.DEV_USER_ID = exports2.STOCKFISH_BOT_USERNAME = exports2.STOCKFISH_BOT_ID = exports2.DEFAULT_CATEGORY_TC = exports2.TIME_CONTROLS = exports2.SUPPORTED_LANGUAGES = exports2.INITIAL_RATING = exports2.INITIAL_FEN = void 0;
    exports2.INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    exports2.INITIAL_RATING = 1500;
    exports2.SUPPORTED_LANGUAGES = ["en", "ru"];
    exports2.TIME_CONTROLS = {
      // Ultra-bullet
      "0.25_0": { initialTime: 15, increment: 0 },
      "0.5_0": { initialTime: 30, increment: 0 },
      // Bullet
      "1_0": { initialTime: 60, increment: 0 },
      "1_1": { initialTime: 60, increment: 1 },
      "2_1": { initialTime: 120, increment: 1 },
      // Blitz
      "3_0": { initialTime: 180, increment: 0 },
      "3_2": { initialTime: 180, increment: 2 },
      "5_0": { initialTime: 300, increment: 0 },
      "5_3": { initialTime: 300, increment: 3 },
      // Rapid
      "10_0": { initialTime: 600, increment: 0 },
      "10_5": { initialTime: 600, increment: 5 },
      "15_10": { initialTime: 900, increment: 10 },
      "30_0": { initialTime: 1800, increment: 0 },
      // Classical
      "30_20": { initialTime: 1800, increment: 20 },
      "60_0": { initialTime: 3600, increment: 0 },
      "60_30": { initialTime: 3600, increment: 30 }
    };
    exports2.DEFAULT_CATEGORY_TC = {
      bullet: { initialTime: 60, increment: 0 },
      blitz: { initialTime: 300, increment: 0 },
      rapid: { initialTime: 600, increment: 0 },
      classical: { initialTime: 1800, increment: 0 }
    };
    exports2.STOCKFISH_BOT_ID = "00000000-0000-4000-a000-000000000001";
    exports2.STOCKFISH_BOT_USERNAME = "Stockfish Bot";
    exports2.DEV_USER_ID = "00000000-0000-4000-a000-000000000002";
    exports2.DEV_USERNAME = "DEV";
    exports2.MAX_ACTIVE_BOT_GAMES = 3;
    exports2.MATCHMAKING_BOTS = [
      { id: "00000000-0000-4000-b000-000000000001", username: "ChessKnight42", rating: 800, botLevel: 1 },
      { id: "00000000-0000-4000-b000-000000000002", username: "PawnStorm", rating: 900, botLevel: 2 },
      { id: "00000000-0000-4000-b000-000000000003", username: "TacticMaster", rating: 1050, botLevel: 3 },
      { id: "00000000-0000-4000-b000-000000000004", username: "SilentBishop", rating: 1150, botLevel: 3 },
      { id: "00000000-0000-4000-b000-000000000005", username: "RookEndgame", rating: 1300, botLevel: 4 },
      { id: "00000000-0000-4000-b000-000000000006", username: "QueenGambit", rating: 1400, botLevel: 5 },
      { id: "00000000-0000-4000-b000-000000000007", username: "KnightFork99", rating: 1500, botLevel: 5 },
      { id: "00000000-0000-4000-b000-000000000008", username: "DarkSquares", rating: 1600, botLevel: 6 },
      { id: "00000000-0000-4000-b000-000000000009", username: "Castling_King", rating: 1700, botLevel: 7 },
      { id: "00000000-0000-4000-b000-00000000000a", username: "BlitzPhenom", rating: 1800, botLevel: 7 },
      { id: "00000000-0000-4000-b000-00000000000b", username: "GrandPatzer", rating: 1900, botLevel: 8 },
      { id: "00000000-0000-4000-b000-00000000000c", username: "ZugzwangPro", rating: 2e3, botLevel: 8 }
    ];
    exports2.DAILY_TIME_CONTROLS = {
      daily1: { daysPerMove: 1, label: "1 day" },
      daily3: { daysPerMove: 3, label: "3 days" },
      daily7: { daysPerMove: 7, label: "7 days" },
      daily14: { daysPerMove: 14, label: "14 days" }
    };
    exports2.MAX_INITIAL_TIME_SEC = 10800;
    exports2.MAX_INCREMENT_SEC = 600;
    exports2.BOARD_THEMES = ["default", "green", "blue", "brown"];
    exports2.PIECE_SETS = ["standard", "cburnett", "alpha", "merida"];
    exports2.USER_LESSON_COMPLETION_THRESHOLD = 0.7;
  }
});

// packages/shared/dist/constants/archive.js
var require_archive2 = __commonJS({
  "packages/shared/dist/constants/archive.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ARCHIVE_PLY_LIMIT = void 0;
    exports2.ARCHIVE_PLY_LIMIT = 40;
  }
});

// packages/shared/dist/types/hint-anchors.js
var require_hint_anchors = __commonJS({
  "packages/shared/dist/types/hint-anchors.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isValidAnchorFormat = isValidAnchorFormat;
    var ANCHOR_RE = /^[a-z][a-z0-9-]*$/;
    var MAX_LEN = 64;
    function isValidAnchorFormat(value) {
      return typeof value === "string" && value.length > 0 && value.length <= MAX_LEN && ANCHOR_RE.test(value);
    }
  }
});

// packages/shared/dist/types/hint-payload.js
var require_hint_payload = __commonJS({
  "packages/shared/dist/types/hint-payload.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/types/hint-templating.js
var require_hint_templating = __commonJS({
  "packages/shared/dist/types/hint-templating.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TRIGGER_VAR_WHITELIST = exports2.HINT_TEMPLATE_PLACEHOLDER_RE = void 0;
    exports2.getTriggerVars = getTriggerVars;
    exports2.applyTemplate = applyTemplate;
    exports2.extractRuleEvents = extractRuleEvents;
    exports2.parseTemplateVars = parseTemplateVars;
    exports2.HINT_TEMPLATE_PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
    exports2.TRIGGER_VAR_WHITELIST = {
      game_end: [
        { name: "game_id", payloadField: "game_id", type: "string" },
        { name: "result", payloadField: "result", type: "string" },
        { name: "time_control", payloadField: "time_control", type: "string" },
        { name: "rating_delta", payloadField: "rating_delta", type: "number" }
      ],
      game_start: [
        { name: "game_id", payloadField: "game_id", type: "string" },
        { name: "time_control", payloadField: "time_control", type: "string" }
      ],
      resign: [
        { name: "game_id", payloadField: "game_id", type: "string" }
      ],
      draw_offered: [
        { name: "game_id", payloadField: "game_id", type: "string" }
      ],
      puzzle_solved: [
        { name: "puzzle_id", payloadField: "puzzle_id", type: "string" },
        { name: "theme", payloadField: "theme", type: "string" },
        { name: "attempts", payloadField: "attempts", type: "number" }
      ],
      puzzle_failed: [
        { name: "puzzle_id", payloadField: "puzzle_id", type: "string" },
        { name: "theme", payloadField: "theme", type: "string" },
        { name: "attempts", payloadField: "attempts", type: "number" }
      ],
      rush_finish: [
        { name: "score", payloadField: "score", type: "number" },
        { name: "mode", payloadField: "mode", type: "string" }
      ],
      lesson_start: [
        { name: "lesson_id", payloadField: "lesson_id", type: "string" },
        { name: "course_id", payloadField: "course_id", type: "string" }
      ],
      lesson_complete: [
        { name: "lesson_id", payloadField: "lesson_id", type: "string" },
        { name: "course_id", payloadField: "course_id", type: "string" }
      ],
      drill_complete: [
        { name: "drill_id", payloadField: "drill_id", type: "string" }
      ],
      analysis_open: [
        { name: "analysis_id", payloadField: "analysis_id", type: "string" },
        { name: "game_id", payloadField: "game_id", type: "string" }
      ],
      // Гостевые и системные — без переменных (см. ADR §2.5).
      guest_landing_viewed: [],
      guest_play_attempted: [],
      page_view: [],
      session_idle: [],
      session_start: [],
      hint_shown: [],
      hint_acted: [],
      hint_used: [],
      engine_started: []
    };
    function getTriggerVars(triggerType) {
      if (!triggerType)
        return [];
      return exports2.TRIGGER_VAR_WHITELIST[triggerType] ?? [];
    }
    function applyTemplate(payload, ctx, fallbackHref = null) {
      const allowed = getTriggerVars(ctx.triggerEventType);
      const resolveVar = (name) => {
        const spec = allowed.find((v) => v.name === name);
        if (!spec)
          return null;
        const raw = ctx.triggerEventPayload?.[spec.payloadField];
        if (raw === void 0 || raw === null)
          return null;
        return String(raw);
      };
      const ctaHrefResolved = (() => {
        const input = payload.ctaHref;
        if (input == null)
          return null;
        if (!exports2.HINT_TEMPLATE_PLACEHOLDER_RE.test(input))
          return input;
        exports2.HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
        let anyUnresolved = false;
        const out = input.replace(exports2.HINT_TEMPLATE_PLACEHOLDER_RE, (_, name) => {
          const v = resolveVar(name);
          if (v == null) {
            anyUnresolved = true;
            return "";
          }
          return encodeURIComponent(v);
        });
        return anyUnresolved ? fallbackHref : out;
      })();
      const replaceText = (input) => {
        if (input == null)
          return null;
        if (!exports2.HINT_TEMPLATE_PLACEHOLDER_RE.test(input))
          return input;
        exports2.HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
        const out = input.replace(exports2.HINT_TEMPLATE_PLACEHOLDER_RE, (_, name) => resolveVar(name) ?? "").trim();
        return out.length > 0 ? out : null;
      };
      const ctaLabelResolved = ctaHrefResolved == null ? null : replaceText(payload.ctaLabel);
      const instructionBodyResolved = replaceText(payload.instructionBody);
      return {
        ...payload,
        ctaHref: ctaHrefResolved,
        ctaLabel: ctaLabelResolved,
        instructionBody: instructionBodyResolved
      };
    }
    function extractRuleEvents(rule) {
      const acc = /* @__PURE__ */ new Set();
      const walk = (node) => {
        if (node === null || typeof node !== "object")
          return;
        const r = node;
        if (Array.isArray(r.all))
          for (const sub of r.all)
            walk(sub);
        if (Array.isArray(r.any))
          for (const sub of r.any)
            walk(sub);
        if (r.not !== void 0)
          walk(r.not);
        for (const op of ["count", "exists", "timeSince"]) {
          const inner = r[op];
          if (inner && typeof inner === "object") {
            const ev = inner.event;
            if (typeof ev === "string" && ev.length > 0)
              acc.add(ev);
          }
        }
      };
      walk(rule);
      return [...acc];
    }
    function parseTemplateVars(input) {
      if (input == null)
        return [];
      exports2.HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
      const seen = /* @__PURE__ */ new Set();
      let m;
      while ((m = exports2.HINT_TEMPLATE_PLACEHOLDER_RE.exec(input)) !== null) {
        seen.add(m[1]);
      }
      return [...seen];
    }
  }
});

// packages/shared/dist/constants/hint-quiet-pages.js
var require_hint_quiet_pages = __commonJS({
  "packages/shared/dist/constants/hint-quiet-pages.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.HINT_QUIET_PAGE_PATTERNS_ALWAYS = exports2.HINT_QUIET_PAGES = void 0;
    exports2.isQuietPage = isQuietPage;
    exports2.quietPagePatternToRegex = quietPagePatternToRegex;
    exports2.HINT_QUIET_PAGES = [
      {
        pattern: "/live/*",
        condition: "always",
        source: "ADR-147 \xA74.2.1 \u2014 \u0438\u043C\u043C\u0435\u0440\u0441\u0438\u0432\u043D\u044B\u0439 \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u0442\u0440\u0430\u043D\u0441\u043B\u044F\u0446\u0438\u0439"
      },
      {
        pattern: "/broadcast/*",
        condition: "always",
        source: "ADR-147 \xA74.2.1 \u2014 \u0438\u043C\u043C\u0435\u0440\u0441\u0438\u0432\u043D\u044B\u0439 \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u0442\u0440\u0430\u043D\u0441\u043B\u044F\u0446\u0438\u0439"
      },
      {
        pattern: "/play/:gameId",
        condition: "low-time-focus",
        source: "ADR-147 \xA74.2.1 + ADR-144 \u2014 \u0440\u0435\u0436\u0438\u043C \u043A\u043E\u043D\u0446\u0435\u043D\u0442\u0440\u0430\u0446\u0438\u0438 \u043D\u0430 \u043D\u0438\u0437\u043A\u043E\u043C \u0432\u0440\u0435\u043C\u0435\u043D\u0438"
      },
      {
        pattern: "/lecture/:id",
        condition: "always",
        source: "ADR-147 \xA74.2.1 + ADR-118 \u2014 \u0440\u0435\u0436\u0438\u043C \u043B\u0435\u043A\u0446\u0438\u0438, \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u0435 \u0437\u0430\u043D\u044F\u0442\u043E"
      },
      {
        pattern: "/admin/*",
        condition: "always",
        source: "ADR-147 \xA74.2.1 \u2014 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u0438\u0432\u043D\u044B\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B"
      }
    ];
    exports2.HINT_QUIET_PAGE_PATTERNS_ALWAYS = exports2.HINT_QUIET_PAGES.filter((p) => p.condition === "always").map((p) => p.pattern);
    function isQuietPage(pathname) {
      if (typeof pathname !== "string" || pathname.length === 0)
        return false;
      for (const pattern of exports2.HINT_QUIET_PAGE_PATTERNS_ALWAYS) {
        if (quietPagePatternToRegex(pattern).test(pathname))
          return true;
      }
      return false;
    }
    function quietPagePatternToRegex(pattern) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const re = escaped.replace(/\*/g, ".+").replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, "[^/]+");
      return new RegExp(`^${re}$`);
    }
  }
});

// packages/shared/dist/types/event-catalog.js
var require_event_catalog = __commonJS({
  "packages/shared/dist/types/event-catalog.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.SYSTEM_EVENT_TYPES = exports2.EVENT_CATALOG = exports2.EVENT_CATEGORIES = void 0;
    exports2.findEventMeta = findEventMeta;
    exports2.resolveEventCategory = resolveEventCategory;
    exports2.EVENT_CATEGORIES = [
      "game",
      "puzzle",
      "lesson",
      "drill",
      "analysis",
      "hint",
      "session",
      "guest",
      "other"
    ];
    exports2.EVENT_CATALOG = [
      // ── game (apps/game-service `endGame`, `resign`, `drawOffer`,
      // apps/api `game.service.ts:trackBoth`) ────────────────────────────
      {
        type: "game_start",
        category: "game",
        titleKey: "event.game_start",
        hrefBuilder: (p) => stringId(p, "game_id", (id) => `/game/${id}`)
      },
      {
        type: "game_end",
        category: "game",
        titleKey: "event.game_end",
        hrefBuilder: (p) => stringId(p, "game_id", (id) => `/game/${id}`)
      },
      {
        type: "resign",
        category: "game",
        titleKey: "event.resign",
        hrefBuilder: (p) => stringId(p, "game_id", (id) => `/game/${id}`)
      },
      {
        type: "draw_offered",
        category: "game",
        titleKey: "event.draw_offered",
        hrefBuilder: (p) => stringId(p, "game_id", (id) => `/game/${id}`)
      },
      // ── puzzle (apps/api/src/puzzle) ──────────────────────────────────
      {
        type: "puzzle_start",
        category: "puzzle",
        titleKey: "event.puzzle_start",
        hrefBuilder: (p) => stringId(p, "puzzle_id", (id) => `/puzzle/${id}`)
      },
      {
        type: "puzzle_solved",
        category: "puzzle",
        titleKey: "event.puzzle_solved",
        hrefBuilder: (p) => stringId(p, "puzzle_id", (id) => `/puzzle/${id}`)
      },
      {
        type: "puzzle_failed",
        category: "puzzle",
        titleKey: "event.puzzle_failed",
        hrefBuilder: (p) => stringId(p, "puzzle_id", (id) => `/puzzle/${id}`)
      },
      // ── puzzle-rush (apps/api/src/puzzle-rush) ────────────────────────
      {
        type: "rush_start",
        category: "puzzle",
        titleKey: "event.rush_start",
        hrefBuilder: () => "/puzzle-rush"
      },
      {
        type: "rush_finish",
        category: "puzzle",
        titleKey: "event.rush_finish",
        hrefBuilder: (p) => stringId(p, "score_id", (id) => `/puzzle-rush/review/${id}`) ?? "/puzzle-rush"
      },
      {
        type: "rush_streak_broken",
        category: "puzzle",
        titleKey: "event.rush_streak_broken"
      },
      // ── lesson (apps/api/src/lessons) ─────────────────────────────────
      {
        type: "lesson_open",
        category: "lesson",
        titleKey: "event.lesson_open",
        hrefBuilder: (p) => buildLessonHref(p)
      },
      {
        type: "lesson_start",
        category: "lesson",
        titleKey: "event.lesson_start",
        hrefBuilder: (p) => buildLessonHref(p)
      },
      {
        type: "lesson_complete",
        category: "lesson",
        titleKey: "event.lesson_complete",
        hrefBuilder: (p) => buildLessonHref(p)
      },
      // ── tactic-drill (apps/api/src/tactic-drill) ──────────────────────
      {
        type: "drill_start",
        category: "drill",
        titleKey: "event.drill_start",
        hrefBuilder: () => "/drills/sprint"
      },
      {
        type: "drill_complete",
        category: "drill",
        titleKey: "event.drill_complete",
        hrefBuilder: () => "/drills/sprint"
      },
      // ── analysis (apps/api/src/analysis) ──────────────────────────────
      {
        type: "analysis_open",
        category: "analysis",
        titleKey: "event.analysis_open",
        hrefBuilder: (p) => stringId(p, "analysis_id", (id) => `/analysis/${id}`) ?? stringId(p, "game_id", (id) => `/game/${id}/review`)
      },
      {
        type: "engine_started",
        category: "analysis",
        titleKey: "event.engine_started"
      },
      // ── hint (apps/api/src/hints, ADR-147 §4.2) ───────────────────────
      {
        type: "hint_shown",
        category: "hint",
        titleKey: "event.hint_shown"
      },
      {
        type: "hint_acted",
        category: "hint",
        titleKey: "event.hint_acted"
      },
      {
        type: "hint_used",
        category: "hint",
        titleKey: "event.hint_used"
      },
      // ── session (системные, скрыты по умолчанию через showSystem=false) ─
      {
        type: "page_view",
        category: "session",
        titleKey: "event.page_view",
        hrefBuilder: (p) => stringField(p, "path")
      },
      {
        type: "session_start",
        category: "session",
        titleKey: "event.session_start"
      },
      {
        type: "session_idle",
        category: "session",
        titleKey: "event.session_idle"
      },
      // ── guest (для гостевых сессий — фоном; не показывается в /me/actions) ─
      {
        type: "guest_landing_viewed",
        category: "guest",
        titleKey: "event.guest_landing_viewed"
      },
      {
        type: "guest_play_attempted",
        category: "guest",
        titleKey: "event.guest_play_attempted"
      },
      // ── other ─────────────────────────────────────────────────────────
      {
        type: "feature_used",
        category: "other",
        titleKey: "event.feature_used"
      },
      {
        type: "no_lives",
        category: "other",
        titleKey: "event.no_lives"
      }
    ];
    exports2.SYSTEM_EVENT_TYPES = [
      "page_view",
      "session_idle",
      "session_start"
    ];
    function findEventMeta(type) {
      return exports2.EVENT_CATALOG.find((m) => m.type === type);
    }
    function resolveEventCategory(type) {
      return findEventMeta(type)?.category ?? "other";
    }
    function stringId(payload, key, builder) {
      const v = payload[key];
      if (typeof v !== "string" || v.length === 0) {
        return null;
      }
      return builder(v);
    }
    function stringField(payload, key) {
      const v = payload[key];
      return typeof v === "string" && v.length > 0 ? v : null;
    }
    function buildLessonHref(payload) {
      const course = payload.course_slug;
      const lesson = payload.lesson_slug;
      if (typeof course === "string" && course.length > 0) {
        if (typeof lesson === "string" && lesson.length > 0) {
          return `/lessons/${course}/${lesson}`;
        }
        return `/lessons/${course}`;
      }
      return null;
    }
  }
});

// packages/shared/dist/utils/time-control.js
var require_time_control = __commonJS({
  "packages/shared/dist/utils/time-control.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ARCHIVE_TIME_CONTROL_EVENT_HINTS = void 0;
    exports2.classifyTimeControl = classifyTimeControl;
    exports2.classifyPgnTimeControl = classifyPgnTimeControl;
    function classifyTimeControl(initialSec, incrementSec) {
      const totalTime = initialSec + 40 * incrementSec;
      if (totalTime < 180)
        return "bullet";
      if (totalTime < 600)
        return "blitz";
      if (totalTime < 3600)
        return "rapid";
      return "classical";
    }
    function classifyPgnTimeControl(tc) {
      if (tc == null)
        return "unknown";
      const trimmed = tc.trim();
      if (trimmed === "" || trimmed === "-" || trimmed === "?")
        return "unknown";
      const firstStage = trimmed.split(":")[0];
      if (!firstStage)
        return "unknown";
      const correspondence = firstStage.match(/^(\d+)\/(\d+)$/);
      if (correspondence) {
        const moves = parseInt(correspondence[1], 10);
        const seconds = parseInt(correspondence[2], 10);
        if (moves === 1 && seconds >= 86400)
          return "unknown";
        if (Number.isFinite(seconds)) {
          return classifyTimeControl(seconds, 0);
        }
        return "unknown";
      }
      const stageWithInc = firstStage.match(/^(\d+)\/(\d+)\+(\d+)$/);
      if (stageWithInc) {
        return classifyTimeControl(parseInt(stageWithInc[2], 10), parseInt(stageWithInc[3], 10));
      }
      const suddenInc = firstStage.match(/^(\d+)\+(\d+)$/);
      if (suddenInc) {
        return classifyTimeControl(parseInt(suddenInc[1], 10), parseInt(suddenInc[2], 10));
      }
      const onlyBase = firstStage.match(/^(\d+)$/);
      if (onlyBase) {
        return classifyTimeControl(parseInt(onlyBase[1], 10), 0);
      }
      return "unknown";
    }
    var EVENT_BULLET_HINTS = [
      "bullet brawl",
      "hourly bullet",
      "bullet arena",
      "bullet"
    ];
    var EVENT_BLITZ_HINTS = [
      "titled tue",
      "titled cup",
      "blitz arena",
      "arena titled",
      "speed chess",
      "speedchess",
      " 3-0 thu",
      "blitz"
    ];
    var EVENT_RAPID_HINTS = [
      "rapidplay",
      "rapid"
    ];
    exports2.ARCHIVE_TIME_CONTROL_EVENT_HINTS = {
      bullet: EVENT_BULLET_HINTS,
      blitz: EVENT_BLITZ_HINTS,
      rapid: EVENT_RAPID_HINTS
    };
  }
});

// packages/shared/dist/utils/fen-key.js
var require_fen_key = __commonJS({
  "packages/shared/dist/utils/fen-key.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.normalizeFenForKey = normalizeFenForKey;
    function normalizeFenForKey(fen) {
      const trimmed = fen.trim();
      if (!trimmed) {
        throw new Error("normalizeFenForKey: FEN is empty");
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) {
        throw new Error(`normalizeFenForKey: FEN must contain at least 4 fields, got ${parts.length}`);
      }
      return parts.slice(0, 3).join(" ");
    }
  }
});

// packages/shared/dist/utils/archive-name-normalize.js
var require_archive_name_normalize = __commonJS({
  "packages/shared/dist/utils/archive-name-normalize.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.normalizeArchiveName = normalizeArchiveName;
    exports2.archiveSlug = archiveSlug;
    var COMBINING_MARKS_RE = /[̀-ͯ]/g;
    var PUNCTUATION_RE = /[,.;:'"\-_/\\]/g;
    var WHITESPACE_RE = /\s+/g;
    function normalizeArchiveName(raw) {
      if (typeof raw !== "string")
        return "";
      return raw.normalize("NFKD").replace(COMBINING_MARKS_RE, "").toLowerCase().replace(PUNCTUATION_RE, " ").replace(WHITESPACE_RE, " ").trim();
    }
    function archiveSlug(raw) {
      const normalized = normalizeArchiveName(raw);
      if (!normalized)
        return "";
      return normalized.replace(/\s+/g, "-");
    }
  }
});

// packages/shared/dist/utils/wdl.js
var require_wdl = __commonJS({
  "packages/shared/dist/utils/wdl.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.wdlSigned = wdlSigned;
    exports2.invertWdl = invertWdl;
    exports2.expectedScoreFromWdl = expectedScoreFromWdl;
    exports2.wdlSignedFromInfo = wdlSignedFromInfo;
    exports2.wdlOrMateFallback = wdlOrMateFallback;
    exports2.deltaWFromWdl = deltaWFromWdl;
    exports2.deltaDFromWdl = deltaDFromWdl;
    function wdlSigned(wdl) {
      return (wdl.w - wdl.l) / 1e3;
    }
    function invertWdl(wdl) {
      return { w: wdl.l, d: wdl.d, l: wdl.w };
    }
    function expectedScoreFromWdl(wdl) {
      return (wdl.w + wdl.d / 2) / 1e3;
    }
    function wdlSignedFromInfo(wdl, score) {
      if (wdl)
        return wdlSigned(wdl);
      if (score.type === "mate")
        return score.value > 0 ? 1 : -1;
      return null;
    }
    function wdlOrMateFallback(wdl, score) {
      if (wdl)
        return wdl;
      if (score.type === "mate") {
        return score.value > 0 ? { w: 1e3, d: 0, l: 0 } : { w: 0, d: 0, l: 1e3 };
      }
      return null;
    }
    function deltaWFromWdl(before, afterRaw) {
      return (before.w - afterRaw.l) / 1e3;
    }
    function deltaDFromWdl(before, afterRaw) {
      return (before.d - afterRaw.d) / 1e3;
    }
  }
});

// packages/shared/dist/utils/puzzle-gen-core.js
var require_puzzle_gen_core = __commonJS({
  "packages/shared/dist/utils/puzzle-gen-core.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.evaluateBlunder = evaluateBlunder;
    exports2.determinePuzzleObjective = determinePuzzleObjective;
    exports2.meetsSolvabilityFinal = meetsSolvabilityFinal;
    exports2.holdsSolvabilityIntermediate = holdsSolvabilityIntermediate;
    var wdl_js_1 = require_wdl();
    function evaluateBlunder(input, settings) {
      const { wdlBeforeRaw: before, wdlAfterRaw: afterRaw } = input;
      const deltaW = (0, wdl_js_1.deltaWFromWdl)(before, afterRaw);
      const deltaD = (0, wdl_js_1.deltaDFromWdl)(before, afterRaw);
      const triggerByW = deltaW >= settings.deltaWThreshold;
      const triggerByD = deltaD >= settings.deltaDThreshold;
      if (!triggerByW && !triggerByD) {
        return { kind: "rejected", reason: "notBlunder", deltaW, deltaD };
      }
      const wAfterForSolver = afterRaw.w / 1e3;
      const dAfterForSolver = afterRaw.d / 1e3;
      if (wAfterForSolver + dAfterForSolver < settings.minWPlusDAfterForSolver) {
        return { kind: "rejected", reason: "lowWplusDAfter", deltaW, deltaD };
      }
      const trigger = triggerByW && triggerByD ? "WD" : triggerByW ? "W" : "D";
      return { kind: "blunder", trigger, deltaW, deltaD };
    }
    function determinePuzzleObjective(wdlAfterRaw) {
      return wdlAfterRaw.w / 1e3 >= 0.5 ? "convertAdvantage" : "saveEquality";
    }
    function meetsSolvabilityFinal(wdlForSolver, objective, winThreshold) {
      if (objective === "convertAdvantage") {
        return (0, wdl_js_1.wdlSigned)(wdlForSolver) >= winThreshold;
      }
      return (wdlForSolver.w + wdlForSolver.d) / 1e3 >= winThreshold;
    }
    function holdsSolvabilityIntermediate(wdlForSolver, objective, failThreshold) {
      if (objective === "convertAdvantage") {
        return (0, wdl_js_1.wdlSigned)(wdlForSolver) >= failThreshold;
      }
      return (wdlForSolver.w + wdlForSolver.d) / 1e3 >= failThreshold;
    }
  }
});

// packages/shared/dist/utils/puzzle-gen-pipeline.js
var require_puzzle_gen_pipeline = __commonJS({
  "packages/shared/dist/utils/puzzle-gen-pipeline.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.passesPlayerEloFilter = passesPlayerEloFilter;
    exports2.replayPgnToSteps = replayPgnToSteps;
    exports2.samePv1 = samePv1;
    exports2.analyzePlyForBlunder = analyzePlyForBlunder;
    exports2.buildPuzzlesFromCandidate = buildPuzzlesFromCandidate;
    exports2.processGameForPuzzles = processGameForPuzzles;
    var chess_js_1 = require_chess();
    var puzzle_gen_core_js_1 = require_puzzle_gen_core();
    var wdl_js_1 = require_wdl();
    function passesPlayerEloFilter(whiteElo, blackElo, minPlayerElo) {
      if (minPlayerElo <= 0)
        return true;
      if (whiteElo == null || blackElo == null)
        return false;
      return whiteElo >= minPlayerElo && blackElo >= minPlayerElo;
    }
    function replayPgnToSteps(pgn, startPly) {
      let chess;
      try {
        chess = new chess_js_1.Chess();
        chess.loadPgn(pgn);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `loadPgn failed: ${msg}` };
      }
      const headers = chess.getHeaders() ?? {};
      const history = chess.history({ verbose: true });
      const replay = new chess_js_1.Chess();
      const steps = [];
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const ply = i + 1;
        const fenBefore = replay.fen();
        const preventiveSolverSide = replay.turn();
        const playedUci = `${m.from}${m.to}${m.promotion ?? ""}`;
        try {
          replay.move({ from: m.from, to: m.to, promotion: m.promotion });
        } catch {
          return { error: `replay move failed at ply=${ply}` };
        }
        if (ply < startPly)
          continue;
        const fenAfter = replay.fen();
        const reactiveSolverSide = replay.turn();
        const isGameOverAfter = replay.isGameOver();
        steps.push({
          ply,
          fenBefore,
          fenAfter,
          playedUci,
          isGameOverAfter,
          reactiveSolverSide,
          preventiveSolverSide
        });
      }
      return { steps, headers };
    }
    function samePv1(playedUci, pv1Uci) {
      if (!playedUci || !pv1Uci)
        return false;
      return playedUci.length >= 4 && pv1Uci.length >= 4 && playedUci === pv1Uci;
    }
    async function analyzePlyForBlunder(step, engine, settings) {
      if (step.isGameOverAfter) {
        return { kind: "rejected", reason: "gameOver" };
      }
      let pre;
      try {
        pre = await engine.analyze(step.fenBefore, 2, {
          label: `ply=${step.ply} phase=analyze stage=pre`
        });
      } catch {
        return { kind: "rejected", reason: "engineError" };
      }
      if (pre.length === 0 || !pre[0].bestMove) {
        return { kind: "rejected", reason: "engineError" };
      }
      if (samePv1(step.playedUci, pre[0].bestMove)) {
        return { kind: "rejected", reason: "samePv1" };
      }
      const wdlBeforeRaw = (0, wdl_js_1.wdlOrMateFallback)(pre[0].wdl, pre[0].score);
      if (wdlBeforeRaw == null) {
        return { kind: "rejected", reason: "noScore" };
      }
      let post;
      try {
        post = await engine.analyze(step.fenAfter, 2, {
          label: `ply=${step.ply} phase=analyze stage=post`
        });
      } catch {
        return { kind: "rejected", reason: "engineError" };
      }
      if (post.length === 0 || !post[0].bestMove) {
        return { kind: "rejected", reason: "engineError" };
      }
      const wdlAfterRaw = (0, wdl_js_1.wdlOrMateFallback)(post[0].wdl, post[0].score);
      if (wdlAfterRaw == null) {
        return { kind: "rejected", reason: "noScore" };
      }
      const evalResult = (0, puzzle_gen_core_js_1.evaluateBlunder)({ wdlBeforeRaw, wdlAfterRaw }, settings);
      if (evalResult.kind === "rejected") {
        return {
          kind: "rejected",
          reason: evalResult.reason,
          deltaW: evalResult.deltaW,
          deltaD: evalResult.deltaD
        };
      }
      return {
        kind: "accepted",
        candidate: {
          step,
          wdlBeforeRaw,
          wdlAfterRaw,
          deltaW: evalResult.deltaW,
          deltaD: evalResult.deltaD,
          trigger: evalResult.trigger,
          pv1BeforeUci: pre[0].bestMove,
          firstMoveAfterUci: post[0].bestMove
        }
      };
    }
    function buildPuzzlesFromCandidate(candidate, gameMeta, settings) {
      const out = [];
      const commonMetaBase = {
        blunderMove: candidate.step.playedUci,
        fenBeforeBlunder: candidate.step.fenBefore,
        wdlBefore: candidate.wdlBeforeRaw,
        wdlAfter: candidate.wdlAfterRaw,
        // Legacy signed-варианты для backward-compat с старыми пазлами.
        wdlBeforeBlunder: round3((0, wdl_js_1.wdlSigned)(candidate.wdlBeforeRaw)),
        wdlAfterBlunder: round3((0, wdl_js_1.wdlSigned)(candidate.wdlAfterRaw)),
        deltaW: round3(candidate.deltaW),
        deltaD: round3(candidate.deltaD),
        blunderTrigger: candidate.trigger,
        halfMovesN: 6,
        winThreshold: settings.deltaWThreshold,
        // не путать с solvability win-thr
        failThreshold: 0,
        headers: gameMeta.headers
      };
      if (settings.emitReactivePuzzle) {
        const objective = (0, puzzle_gen_core_js_1.determinePuzzleObjective)(candidate.wdlAfterRaw);
        const themes = ["playVsEngine", objective, "reactive"];
        out.push({
          fen: candidate.step.fenAfter,
          sourceType: gameMeta.sourceType,
          sourceId: gameMeta.sourceId,
          sourceMoveNum: candidate.step.ply,
          themes,
          rating: 1500,
          // обёртка обычно пересчитывает через computeStartingRating
          solutionMode: "play-vs-engine",
          puzzlePhase: "reactive",
          objective,
          solverSide: candidate.step.reactiveSolverSide,
          sourceMetadata: {
            ...commonMetaBase,
            objective,
            puzzlePhase: "reactive",
            firstMovePV1: candidate.firstMoveAfterUci
          }
        });
      }
      if (settings.emitPreventivePuzzle) {
        const wBeforePm = (candidate.wdlBeforeRaw.w + candidate.wdlBeforeRaw.d) / 1e3;
        if (wBeforePm >= 0.5) {
          const objectiveP = candidate.wdlBeforeRaw.w / 1e3 >= 0.5 ? "convertAdvantage" : "saveEquality";
          const themes = ["playVsEngine", objectiveP, "preventive"];
          out.push({
            fen: candidate.step.fenBefore,
            sourceType: gameMeta.sourceType,
            sourceId: gameMeta.sourceId,
            sourceMoveNum: candidate.step.ply,
            themes,
            rating: 1500,
            solutionMode: "play-vs-engine",
            puzzlePhase: "preventive",
            objective: objectiveP,
            solverSide: candidate.step.preventiveSolverSide,
            sourceMetadata: {
              ...commonMetaBase,
              objective: objectiveP,
              puzzlePhase: "preventive",
              // KS-4100 / ADR-124 §2.4. ИНВАРИАНТ: каждый PVE-пазл обязан
              // иметь `firstMovePV1` — правильный первый ход solver'а. Для
              // preventive это PV1 движка на fenBefore (то, что должен был
              // сыграть «зевнувший»). Раньше поле НЕ ставилось → Maia-
              // аннотация падала `no-solution-uci` (корень KS-4096, 2/13
              // пазлов с maiaWeakChoiceProb=null). Чинится один раз в общем
              // pipeline — исправляет и клиент, и сервер.
              firstMovePV1: candidate.pv1BeforeUci,
              // Правильный ход (PV1 движка на fenBefore) — то, что должен
              // был сыграть «зевнувший». UI может подсветить как hint.
              // Дубликат firstMovePV1 — оставлен для обратной совместимости.
              preventiveCorrectMoveUci: candidate.pv1BeforeUci
            }
          });
        }
      }
      return out;
    }
    async function processGameForPuzzles(args2) {
      const replay = replayPgnToSteps(args2.pgn, args2.settings.startPly);
      if ("error" in replay) {
        return {
          puzzles: [],
          stats: {
            positionsAnalyzed: 0,
            drops: emptyDrops()
          }
        };
      }
      const stats = {
        positionsAnalyzed: 0,
        drops: emptyDrops()
      };
      const puzzles = [];
      for (let i = 0; i < replay.steps.length; i++) {
        if (args2.abortSignal?.aborted)
          break;
        const step = replay.steps[i];
        stats.positionsAnalyzed++;
        const r = await analyzePlyForBlunder(step, args2.engine, args2.settings);
        if (r.kind === "rejected") {
          stats.drops[r.reason]++;
          args2.onProgress?.({ ply: i + 1, total: replay.steps.length });
          continue;
        }
        const built = buildPuzzlesFromCandidate(r.candidate, args2.gameMeta, args2.settings);
        puzzles.push(...built);
        args2.onProgress?.({ ply: i + 1, total: replay.steps.length });
      }
      return { puzzles, stats };
    }
    function emptyDrops() {
      return {
        samePv1: 0,
        gameOver: 0,
        noScore: 0,
        engineError: 0,
        notBlunder: 0,
        lowWplusDAfter: 0
      };
    }
    function round3(x) {
      return Math.round(x * 1e3) / 1e3;
    }
  }
});

// packages/shared/dist/utils/tactic-puzzle-gen.js
var require_tactic_puzzle_gen = __commonJS({
  "packages/shared/dist/utils/tactic-puzzle-gen.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TACTIC_PUZZLE_GEN_DEFAULTS = void 0;
    exports2.analyzePlyForTacticPuzzle = analyzePlyForTacticPuzzle;
    exports2.replayPgnForTacticPuzzles = replayPgnForTacticPuzzles;
    exports2.newTacticDropStats = newTacticDropStats;
    exports2.processGameForTacticPuzzles = processGameForTacticPuzzles;
    var chess_js_1 = require_chess();
    exports2.TACTIC_PUZZLE_GEN_DEFAULTS = {
      startPly: 20,
      sfMainNodes: 1e6,
      sfVerifyNodes: 1e7,
      sfMultiPv: 10,
      maiaElo: 2400,
      epsEquiv: 0.02,
      difficultyMin: 0.9,
      loseMax: 0.5,
      gapMin: 0.2
    };
    function sideToMoveFromFen(fen) {
      return fen.split(" ")[1] === "b" ? "b" : "w";
    }
    function uniqueStrongMove(lines, epsEquiv) {
      const bestE = Math.max(...lines.map((l) => l.E));
      const strong = lines.filter((l) => bestE - l.E <= epsEquiv);
      return { strong, bestE };
    }
    async function analyzePlyForTacticPuzzle(step, sf, maia, settings, ctx) {
      if (step.isGameOver)
        return { kind: "rejected", reason: "gameOver" };
      const mkLabel = (phase) => ctx?.gameId ? `tactic:${phase} g=${ctx.gameId} ply=${step.ply}` : `tactic:${phase} ply=${step.ply}`;
      let mainLines;
      try {
        const r = await sf.analyze(step.fen, settings.sfMultiPv, settings.sfMainNodes, { label: mkLabel("main"), signal: ctx?.signal });
        mainLines = r.lines;
      } catch {
        return { kind: "rejected", reason: "engineError" };
      }
      if (mainLines.length === 0) {
        return { kind: "rejected", reason: "noEngineLines" };
      }
      const mainPick = uniqueStrongMove(mainLines, settings.epsEquiv);
      if (mainPick.strong.length !== 1) {
        return { kind: "rejected", reason: "notUniqueStrongMain" };
      }
      let policy;
      try {
        const res = await maia.predictMoves(step.fen, settings.maiaElo, settings.maiaElo);
        policy = res.policy;
      } catch {
        return { kind: "rejected", reason: "maiaInferenceFailed" };
      }
      const policyMap = new Map(policy.map((p) => [p.move, p.probability]));
      const strongProb = mainPick.strong.reduce((sum, l) => sum + (policyMap.get(l.move) ?? 0), 0);
      const difficulty = 1 - strongProb;
      if (difficulty <= settings.difficultyMin) {
        return { kind: "rejected", reason: "maiaLowDifficulty" };
      }
      let verifyLines;
      let depth;
      try {
        const r = await sf.analyze(step.fen, settings.sfMultiPv, settings.sfVerifyNodes, { label: mkLabel("verify"), signal: ctx?.signal });
        verifyLines = r.lines;
        depth = r.maxDepth;
      } catch {
        return { kind: "rejected", reason: "engineError" };
      }
      if (verifyLines.length === 0) {
        return { kind: "rejected", reason: "noEngineLines" };
      }
      const verifyPick = uniqueStrongMove(verifyLines, settings.epsEquiv);
      if (verifyPick.strong.length !== 1) {
        return { kind: "rejected", reason: "notUniqueStrongVerify" };
      }
      if (verifyPick.strong[0].move !== mainPick.strong[0].move) {
        return { kind: "rejected", reason: "bestMoveMismatch" };
      }
      const bestLine = verifyPick.strong[0];
      if (!bestLine.wdl)
        return { kind: "rejected", reason: "engineError" };
      const bestL = bestLine.wdl.l / 1e3;
      if (bestL > settings.loseMax) {
        return { kind: "rejected", reason: "bestMoveLoses" };
      }
      const sortedByE = [...verifyLines].sort((a, b) => b.E - a.E);
      const secondE = sortedByE.length >= 2 ? sortedByE[1].E : 0;
      const gap = verifyPick.bestE - secondE;
      if (gap < settings.gapMin) {
        return { kind: "rejected", reason: "gapTooSmall" };
      }
      const solverSide = sideToMoveFromFen(step.fen);
      return {
        kind: "accepted",
        candidate: {
          ply: step.ply,
          fen: step.fen,
          solverSide,
          bestMoveUci: bestLine.move,
          bestE: verifyPick.bestE,
          secondE,
          gap,
          wdl: bestLine.wdl,
          difficulty,
          depth
        }
      };
    }
    function replayPgnForTacticPuzzles(pgn, startPly) {
      let chess;
      try {
        chess = new chess_js_1.Chess();
        chess.loadPgn(pgn);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `loadPgn failed: ${msg}` };
      }
      const headers = chess.getHeaders() ?? {};
      const history = chess.history({ verbose: true });
      const replay = new chess_js_1.Chess();
      const steps = [];
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const ply = i + 1;
        const fen = replay.fen();
        const isGameOver = replay.isGameOver();
        try {
          replay.move({ from: m.from, to: m.to, promotion: m.promotion });
        } catch {
          return { error: `replay move failed at ply=${ply}` };
        }
        if (ply < startPly)
          continue;
        steps.push({ ply, fen, isGameOver });
      }
      return { steps, headers };
    }
    function newTacticDropStats() {
      return {
        gameOver: 0,
        engineError: 0,
        noEngineLines: 0,
        notUniqueStrongMain: 0,
        maiaInferenceFailed: 0,
        maiaLowDifficulty: 0,
        notUniqueStrongVerify: 0,
        bestMoveMismatch: 0,
        bestMoveLoses: 0,
        gapTooSmall: 0
      };
    }
    async function processGameForTacticPuzzles(args2) {
      const replay = replayPgnForTacticPuzzles(args2.pgn, args2.settings.startPly);
      if ("error" in replay)
        return { error: replay.error };
      const candidates = [];
      const drops = newTacticDropStats();
      let positionsAnalyzed = 0;
      for (const step of replay.steps) {
        if (args2.signal?.aborted)
          break;
        const result = await analyzePlyForTacticPuzzle(step, args2.sf, args2.maia, args2.settings, { signal: args2.signal, gameId: args2.gameId });
        if (result.kind === "accepted") {
          positionsAnalyzed++;
          candidates.push(result.candidate);
          continue;
        }
        drops[result.reason]++;
        if (result.reason !== "engineError" && result.reason !== "maiaInferenceFailed" && result.reason !== "gameOver") {
          positionsAnalyzed++;
        }
      }
      return {
        candidates,
        stats: { positionsAnalyzed, drops },
        headers: replay.headers
      };
    }
  }
});

// packages/shared/dist/utils/precision-score.js
var require_precision_score = __commonJS({
  "packages/shared/dist/utils/precision-score.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.OBJECTIVE_TOLERANCE = exports2.MIN_DATA_FRACTION = exports2.MIN_HALF_MOVES_FOR_SCORE = exports2.CLASSIFICATION_FALLBACK_ACCURACY = exports2.WORST_CLASS_CAP = exports2.COMPOSITE_MIN_WEIGHT = exports2.COMPOSITE_MEAN_WEIGHT = exports2.STAR_THRESHOLDS = void 0;
    exports2.winPctFromCp = winPctFromCp;
    exports2.accuracyMove = accuracyMove;
    exports2.worstClassification = worstClassification;
    exports2.mapToStars = mapToStars;
    exports2.aggregateAccuracies = aggregateAccuracies;
    exports2.computeStartExpectedScore = computeStartExpectedScore;
    exports2.computeEndExpectedScore = computeEndExpectedScore;
    exports2.precisionFromExpectedScoreDelta = precisionFromExpectedScoreDelta;
    exports2.computePrecisionScore = computePrecisionScore;
    exports2.evaluateObjectiveAchieved = evaluateObjectiveAchieved;
    exports2.computeAttemptObjectiveAchieved = computeAttemptObjectiveAchieved;
    exports2.computeVerdictKey = computeVerdictKey;
    exports2.STAR_THRESHOLDS = {
      five: 95,
      four: 85,
      three: 70,
      two: 50
    };
    exports2.COMPOSITE_MEAN_WEIGHT = 0.7;
    exports2.COMPOSITE_MIN_WEIGHT = 0.3;
    exports2.WORST_CLASS_CAP = {
      blunder: 60,
      mistake: 80
    };
    exports2.CLASSIFICATION_FALLBACK_ACCURACY = {
      best: 95,
      good: 80,
      inaccuracy: 55,
      mistake: 25,
      blunder: 5
    };
    exports2.MIN_HALF_MOVES_FOR_SCORE = 1;
    exports2.MIN_DATA_FRACTION = 0.5;
    var ACC_A = 103.1668;
    var ACC_B = -0.04354;
    var ACC_C = -3.1669;
    var CP_TO_WIN_K = -368208e-8;
    function clamp(value, min, max) {
      if (!Number.isFinite(value))
        return min;
      if (value < min)
        return min;
      if (value > max)
        return max;
      return value;
    }
    function winPctFromCp(cp) {
      if (!Number.isFinite(cp))
        return 50;
      const raw = 50 + 50 * (2 / (1 + Math.exp(CP_TO_WIN_K * cp)) - 1);
      return clamp(raw, 0, 100);
    }
    function accuracyMove(move) {
      const playedMatchesBest = typeof move.playedUci === "string" && typeof move.bestUci === "string" && move.playedUci === move.bestUci;
      if (move.isBestMove === true || playedMatchesBest || move.classification === "best") {
        return 100;
      }
      if (move.wdlBefore && move.wdlAfter) {
        const eBefore = (move.wdlBefore.w + move.wdlBefore.d / 2) / 1e3;
        const eAfter = (move.wdlAfter.w + move.wdlAfter.d / 2) / 1e3;
        const lossPct = Math.max(0, eBefore - eAfter) * 100;
        return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
      }
      if (move.classification) {
        return exports2.CLASSIFICATION_FALLBACK_ACCURACY[move.classification];
      }
      return null;
    }
    var CLASS_ORDER = [
      "best",
      "good",
      "inaccuracy",
      "mistake",
      "blunder"
    ];
    function worstClassification(moves) {
      let worstIdx = -1;
      for (const m of moves) {
        if (!m.classification)
          continue;
        const idx = CLASS_ORDER.indexOf(m.classification);
        if (idx > worstIdx)
          worstIdx = idx;
      }
      return worstIdx >= 0 ? CLASS_ORDER[worstIdx] : null;
    }
    function mapToStars(scorePct) {
      if (scorePct >= exports2.STAR_THRESHOLDS.five)
        return 5;
      if (scorePct >= exports2.STAR_THRESHOLDS.four)
        return 4;
      if (scorePct >= exports2.STAR_THRESHOLDS.three)
        return 3;
      if (scorePct >= exports2.STAR_THRESHOLDS.two)
        return 2;
      return 1;
    }
    function aggregateAccuracies(accuracies, worst) {
      if (accuracies.length === 0)
        return { stars: null, scorePct: null };
      const mean = accuracies.reduce((acc, v) => acc + v, 0) / accuracies.length;
      let min = accuracies[0];
      for (let i = 1; i < accuracies.length; i++) {
        if (accuracies[i] < min)
          min = accuracies[i];
      }
      let scorePct = exports2.COMPOSITE_MEAN_WEIGHT * mean + exports2.COMPOSITE_MIN_WEIGHT * min;
      if (worst === "blunder") {
        scorePct = Math.min(scorePct, exports2.WORST_CLASS_CAP.blunder);
      } else if (worst === "mistake") {
        scorePct = Math.min(scorePct, exports2.WORST_CLASS_CAP.mistake);
      }
      return { stars: mapToStars(scorePct), scorePct };
    }
    function computeStartExpectedScore(moves) {
      for (const m of moves) {
        if (m.wdlBefore) {
          return (m.wdlBefore.w + m.wdlBefore.d / 2) / 1e3;
        }
      }
      return null;
    }
    function computeEndExpectedScore(moves) {
      for (let i = moves.length - 1; i >= 0; i--) {
        const wdlAfter = moves[i].wdlAfter;
        if (wdlAfter) {
          return (wdlAfter.w + wdlAfter.d / 2) / 1e3;
        }
      }
      return null;
    }
    function precisionFromExpectedScoreDelta(startE, endE) {
      const lossE = Math.max(0, startE - endE);
      const lossPct = lossE * 100;
      return clamp(ACC_A * Math.exp(ACC_B * lossPct) + ACC_C, 0, 100);
    }
    function computePrecisionScore(moves) {
      if (moves.length < exports2.MIN_HALF_MOVES_FOR_SCORE) {
        return { stars: null, scorePct: null };
      }
      const startE = computeStartExpectedScore(moves);
      const endE = computeEndExpectedScore(moves);
      if (startE === null || endE === null) {
        return { stars: null, scorePct: null };
      }
      const scorePct = precisionFromExpectedScoreDelta(startE, endE);
      return { stars: mapToStars(scorePct), scorePct };
    }
    exports2.OBJECTIVE_TOLERANCE = {
      convertAdvantage: 0.02,
      saveEquality: 0.05
    };
    function evaluateObjectiveAchieved(startE, endE, objective) {
      if (typeof startE !== "number" || typeof endE !== "number")
        return null;
      if (!Number.isFinite(startE) || !Number.isFinite(endE))
        return null;
      const tolerance = exports2.OBJECTIVE_TOLERANCE[objective];
      return endE >= startE - tolerance;
    }
    function computeAttemptObjectiveAchieved(moves, objective) {
      let startE = null;
      for (const m of moves) {
        if (m.wdlBefore) {
          startE = (m.wdlBefore.w + m.wdlBefore.d / 2) / 1e3;
          break;
        }
      }
      let endE = null;
      for (let i = moves.length - 1; i >= 0; i--) {
        const wdlAfter = moves[i].wdlAfter;
        if (wdlAfter) {
          endE = (wdlAfter.w + wdlAfter.d / 2) / 1e3;
          break;
        }
      }
      return evaluateObjectiveAchieved(startE, endE, objective);
    }
    function computeVerdictKey(stars, objectiveAchieved) {
      if (stars === null)
        return null;
      const achieved = objectiveAchieved === false ? false : true;
      if (achieved) {
        switch (stars) {
          case 5:
            return "flawless";
          case 4:
            return "confident";
          case 3:
            return "suboptimal";
          case 2:
            return "with-mistakes";
          case 1:
            return "with-blunders";
        }
      }
      switch (stars) {
        case 5:
          return "flawless";
        // теоретически невозможно
        case 4:
          return "goal-missed-clean";
        case 3:
          return "goal-missed";
        case 2:
          return "goal-missed-mistakes";
        case 1:
          return "goal-missed-blunders";
      }
    }
  }
});

// packages/shared/dist/utils/move-classification.js
var require_move_classification = __commonJS({
  "packages/shared/dist/utils/move-classification.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CP_LOSS_THRESHOLDS = exports2.MATE_WDL_THRESHOLD = exports2.WDL_LOSS_THRESHOLDS = exports2.MATE_CP_BASE = void 0;
    exports2.classifyMove = classifyMove;
    var precision_score_js_1 = require_precision_score();
    exports2.MATE_CP_BASE = 1e5;
    exports2.WDL_LOSS_THRESHOLDS = {
      /** loss_E ≤ 0.02 → `best`. */
      best: 0.02,
      /** 0.02 < loss_E ≤ 0.05 → `good`. */
      good: 0.05,
      /** 0.05 < loss_E ≤ 0.12 → `inaccuracy`. */
      inaccuracy: 0.12,
      /** 0.12 < loss_E ≤ 0.50 → `mistake` (расширен с 0.25 в KS-3615 follow-up). */
      mistake: 0.5
    };
    exports2.MATE_WDL_THRESHOLD = 950;
    exports2.CP_LOSS_THRESHOLDS = {
      best: 0,
      good: 30,
      inaccuracy: 90,
      mistake: 220
    };
    function classifyMove(input) {
      if (input.isBestMove === true) {
        return "best";
      }
      const wdlAfter = input.wdlAfter;
      if (wdlAfter) {
        if (wdlAfter.l > exports2.MATE_WDL_THRESHOLD)
          return "blunder";
        if (wdlAfter.w > exports2.MATE_WDL_THRESHOLD)
          return "best";
      }
      const hasWdl = !!(input.wdlBefore && input.wdlAfter);
      if (!hasWdl && typeof input.cpAfter === "number") {
        if (input.cpAfter <= -exports2.MATE_CP_BASE / 2)
          return "blunder";
        if (input.cpAfter >= exports2.MATE_CP_BASE / 2)
          return "best";
      }
      let lossE = null;
      if (input.wdlBefore && input.wdlAfter) {
        const eBefore = (input.wdlBefore.w + input.wdlBefore.d / 2) / 1e3;
        const eAfter = (input.wdlAfter.w + input.wdlAfter.d / 2) / 1e3;
        lossE = Math.max(0, eBefore - eAfter);
      } else if (typeof input.cpBefore === "number" && typeof input.cpAfter === "number") {
        const winBefore = (0, precision_score_js_1.winPctFromCp)(input.cpBefore);
        const winAfter = (0, precision_score_js_1.winPctFromCp)(input.cpAfter);
        lossE = Math.max(0, (winBefore - winAfter) / 100);
      }
      if (lossE === null)
        return "good";
      if (lossE <= exports2.WDL_LOSS_THRESHOLDS.best)
        return "best";
      if (lossE <= exports2.WDL_LOSS_THRESHOLDS.good)
        return "good";
      if (lossE <= exports2.WDL_LOSS_THRESHOLDS.inaccuracy)
        return "inaccuracy";
      if (lossE <= exports2.WDL_LOSS_THRESHOLDS.mistake)
        return "mistake";
      return "blunder";
    }
  }
});

// packages/shared/dist/utils/guess-move.js
var require_guess_move = __commonJS({
  "packages/shared/dist/utils/guess-move.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GUESS_VERDICT_EPSILON = void 0;
    exports2.compareGuessMove = compareGuessMove;
    exports2.decideVerdict = decideVerdict;
    var wdl_js_1 = require_wdl();
    var precision_score_js_1 = require_precision_score();
    var move_classification_js_1 = require_move_classification();
    exports2.GUESS_VERDICT_EPSILON = move_classification_js_1.WDL_LOSS_THRESHOLDS.best;
    function compareGuessMove(playedUci, userUci, evals) {
      const sameMove = userUci === playedUci;
      const wdlBefore = evals.wdlBefore;
      const wdlAfterPlayedPov = (0, wdl_js_1.invertWdl)(evals.wdlAfterPlayed);
      const wdlAfterUserRaw = sameMove || evals.wdlAfterUser == null ? evals.wdlAfterPlayed : evals.wdlAfterUser;
      const wdlAfterUserPov = (0, wdl_js_1.invertWdl)(wdlAfterUserRaw);
      const eBefore = (0, wdl_js_1.expectedScoreFromWdl)(wdlBefore);
      const eAfterPlayed = (0, wdl_js_1.expectedScoreFromWdl)(wdlAfterPlayedPov);
      const eAfterUser = (0, wdl_js_1.expectedScoreFromWdl)(wdlAfterUserPov);
      const lossPlayer = Math.max(0, eBefore - eAfterPlayed);
      const lossUser = Math.max(0, eBefore - eAfterUser);
      const accuracyPlayer = (0, precision_score_js_1.accuracyMove)({ wdlBefore, wdlAfter: wdlAfterPlayedPov }) ?? 0;
      const accuracyUser = (0, precision_score_js_1.accuracyMove)({ wdlBefore, wdlAfter: wdlAfterUserPov }) ?? 0;
      const userClass = (0, move_classification_js_1.classifyMove)({
        wdlBefore,
        wdlAfter: wdlAfterUserPov,
        isBestMove: userUci === evals.bestUci
      });
      const verdict = decideVerdict(lossUser, lossPlayer);
      return {
        eBefore,
        eAfterPlayed,
        eAfterUser,
        lossPlayer,
        lossUser,
        accuracyPlayer,
        accuracyUser,
        userClass,
        verdict
      };
    }
    function decideVerdict(lossUser, lossPlayer) {
      if (Math.abs(lossUser - lossPlayer) <= exports2.GUESS_VERDICT_EPSILON)
        return "asPlayer";
      if (lossUser <= move_classification_js_1.WDL_LOSS_THRESHOLDS.best && lossPlayer - lossUser > exports2.GUESS_VERDICT_EPSILON) {
        return "strongest";
      }
      if (lossUser < lossPlayer - exports2.GUESS_VERDICT_EPSILON)
        return "betterThanPlayer";
      return "weaker";
    }
  }
});

// packages/shared/dist/utils/blind-board/move-gen.js
var require_move_gen = __commonJS({
  "packages/shared/dist/utils/blind-board/move-gen.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseSquare = parseSquare;
    exports2.makeSquare = makeSquare;
    exports2.geometricMoves = geometricMoves;
    exports2.attacks = attacks;
    exports2.findUniqueTargetMoves = findUniqueTargetMoves;
    var FILES = "abcdefgh";
    var KNIGHT_OFFSETS = [
      [1, 2],
      [2, 1],
      [2, -1],
      [1, -2],
      [-1, -2],
      [-2, -1],
      [-2, 1],
      [-1, 2]
    ];
    var ROOK_DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    var BISHOP_DIRS = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1]
    ];
    var QUEEN_DIRS = [
      ...ROOK_DIRS,
      ...BISHOP_DIRS
    ];
    function parseSquare(sq) {
      const f = FILES.indexOf(sq[0]);
      const r = parseInt(sq[1], 10) - 1;
      return [f, r];
    }
    function makeSquare(f, r) {
      if (f < 0 || f > 7 || r < 0 || r > 7)
        return null;
      return `${FILES[f]}${r + 1}`;
    }
    function positionMap(position) {
      const m = /* @__PURE__ */ new Map();
      for (const p of position)
        m.set(p.square, p.type);
      return m;
    }
    function dirsFor(type) {
      switch (type) {
        case "R":
          return ROOK_DIRS;
        case "B":
          return BISHOP_DIRS;
        case "Q":
          return QUEEN_DIRS;
        case "N":
          return [];
      }
    }
    function geometricMoves(piece, position) {
      const map = positionMap(position);
      const [f0, r0] = parseSquare(piece.square);
      const out = [];
      if (piece.type === "N") {
        for (const [df, dr] of KNIGHT_OFFSETS) {
          const sq = makeSquare(f0 + df, r0 + dr);
          if (!sq)
            continue;
          if (map.has(sq) && sq !== piece.square)
            continue;
          out.push(sq);
        }
        return out;
      }
      for (const [df, dr] of dirsFor(piece.type)) {
        let f = f0 + df;
        let r = r0 + dr;
        while (true) {
          const sq = makeSquare(f, r);
          if (!sq)
            break;
          if (map.has(sq) && sq !== piece.square)
            break;
          out.push(sq);
          f += df;
          r += dr;
        }
      }
      return out;
    }
    function attacks(piece, position) {
      const map = positionMap(position);
      const [f0, r0] = parseSquare(piece.square);
      const out = /* @__PURE__ */ new Set();
      if (piece.type === "N") {
        for (const [df, dr] of KNIGHT_OFFSETS) {
          const sq = makeSquare(f0 + df, r0 + dr);
          if (sq)
            out.add(sq);
        }
        return out;
      }
      for (const [df, dr] of dirsFor(piece.type)) {
        let f = f0 + df;
        let r = r0 + dr;
        while (true) {
          const sq = makeSquare(f, r);
          if (!sq)
            break;
          out.add(sq);
          if (map.has(sq) && sq !== piece.square)
            break;
          f += df;
          r += dr;
        }
      }
      return out;
    }
    function findUniqueTargetMoves(position, targetPieceSquare, options = {}) {
      const requireNovelty = options.requireNovelty ?? true;
      const target = position.find((p) => p.square === targetPieceSquare);
      if (!target)
        return [];
      const others = position.filter((p) => p.square !== targetPieceSquare);
      const cAttacksBefore = attacks(target, position);
      const attackersOfFrom = /* @__PURE__ */ new Set();
      for (const Q of others) {
        if (attacks(Q, position).has(target.square)) {
          attackersOfFrom.add(Q.square);
        }
      }
      const candidates = [];
      for (const to of geometricMoves(target, position)) {
        const movedPiece = { square: to, type: target.type };
        const newPosition = [...others, movedPiece];
        const movedAtk = attacks(movedPiece, newPosition);
        const involved = [];
        for (const Q of others) {
          const qAtk = attacks(Q, newPosition);
          if (movedAtk.has(Q.square) || qAtk.has(to)) {
            involved.push(Q);
          }
        }
        if (involved.length !== 1)
          continue;
        if (requireNovelty) {
          const inv = involved[0];
          const cAttackedInvBefore = cAttacksBefore.has(inv.square);
          const invAttackedCBefore = attackersOfFrom.has(inv.square);
          if (cAttackedInvBefore || invAttackedCBefore)
            continue;
        }
        candidates.push({ to, target: involved[0] });
      }
      return candidates;
    }
  }
});

// packages/shared/dist/utils/precision-themes.js
var require_precision_themes = __commonJS({
  "packages/shared/dist/utils/precision-themes.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PRECISION_RELEVANT_THEMES = exports2.PRECISION_THEME_GROUPS = void 0;
    exports2.isPrecisionRelevantTheme = isPrecisionRelevantTheme;
    var TACTICS_THEMES = [
      "pin",
      "fork",
      "skewer",
      "discoveredAttack",
      "doubleCheck",
      "sacrifice",
      "deflection",
      "attraction",
      "clearance",
      "interference",
      "intermezzo",
      "xRayAttack",
      "hangingPiece",
      "capturingDefender",
      "trappedPiece"
    ];
    var MATES_THEMES = [
      "mate",
      "mateIn1",
      "mateIn2",
      "mateIn3",
      "mateIn4",
      "mateIn5",
      "backRankMate",
      "smotheredMate",
      "arabianMate",
      "anapierce",
      "bodenMate",
      "dovetailMate",
      "hookMate",
      "doubleBishopMate"
    ];
    var ENDGAME_THEMES = [
      "endgame",
      "pawnEndgame",
      "rookEndgame",
      "queenEndgame",
      "knightEndgame",
      "bishopEndgame",
      "queenRookEndgame",
      "mixedEndgame",
      "promotion",
      "underPromotion",
      "advancedPawn"
    ];
    var PHASE_THEMES = ["opening", "middlegame"];
    var ADVANTAGE_THEMES = ["advantage", "crushing", "equality"];
    var MISC_THEMES = [
      "zugzwang",
      "kingsideAttack",
      "queensideAttack",
      "attackingF2F7",
      "exposedKing",
      "defensiveMove",
      "quietMove",
      "enPassant",
      "castling"
    ];
    exports2.PRECISION_THEME_GROUPS = {
      tactics: TACTICS_THEMES,
      mates: MATES_THEMES,
      endgame: ENDGAME_THEMES,
      phase: PHASE_THEMES,
      advantage: ADVANTAGE_THEMES,
      misc: MISC_THEMES
    };
    exports2.PRECISION_RELEVANT_THEMES = [
      ...TACTICS_THEMES,
      ...MATES_THEMES,
      ...ENDGAME_THEMES,
      ...PHASE_THEMES,
      ...ADVANTAGE_THEMES,
      ...MISC_THEMES
    ];
    function isPrecisionRelevantTheme(theme) {
      return exports2.PRECISION_RELEVANT_THEMES.includes(theme);
    }
  }
});

// packages/shared/dist/chess/pin.js
var require_pin = __commonJS({
  "packages/shared/dist/chess/pin.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.findPinAnchor = findPinAnchor;
    exports2.pseudoTargets = pseudoTargets;
    exports2.existsTargetOffPinLine = existsTargetOffPinLine;
    var DIRECTIONS = [
      [0, 1, "rook"],
      [0, -1, "rook"],
      [1, 0, "rook"],
      [-1, 0, "rook"],
      [1, 1, "bishop"],
      [1, -1, "bishop"],
      [-1, 1, "bishop"],
      [-1, -1, "bishop"]
    ];
    function squareAt(file, rank) {
      if (file < 0 || file > 7 || rank < 0 || rank > 7)
        return null;
      return String.fromCharCode(97 + file) + (rank + 1);
    }
    function isSlider(pieceType, dir) {
      if (pieceType === "q")
        return true;
      if (pieceType === "r" && dir === "rook")
        return true;
      if (pieceType === "b" && dir === "bishop")
        return true;
      return false;
    }
    function findPinAnchor(chess, pSq, pColor) {
      const enemy = pColor === "w" ? "b" : "w";
      const file = pSq.charCodeAt(0) - 97;
      const rank = parseInt(pSq[1], 10) - 1;
      for (const [dx, dy, kind] of DIRECTIONS) {
        let sliderSq = null;
        {
          let f = file + dx;
          let r = rank + dy;
          while (true) {
            const cell = squareAt(f, r);
            if (!cell)
              break;
            const piece = chess.get(cell);
            if (piece) {
              if (piece.color === enemy && isSlider(piece.type, kind)) {
                sliderSq = cell;
              }
              break;
            }
            f += dx;
            r += dy;
          }
        }
        if (!sliderSq)
          continue;
        let anchorSq = null;
        let anchorType = null;
        {
          let f = file - dx;
          let r = rank - dy;
          while (true) {
            const cell = squareAt(f, r);
            if (!cell)
              break;
            const piece = chess.get(cell);
            if (piece) {
              if (piece.color === pColor) {
                anchorSq = cell;
                anchorType = piece.type;
              }
              break;
            }
            f -= dx;
            r -= dy;
          }
        }
        if (!anchorSq || !anchorType)
          continue;
        return {
          sliderSq,
          anchorSq,
          anchorType,
          dx,
          dy
        };
      }
      return null;
    }
    function pseudoTargets(chess, sq, type, color) {
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1], 10) - 1;
      const enemy = color === "w" ? "b" : "w";
      const out = [];
      const sqAt = (f, r) => {
        if (f < 0 || f > 7 || r < 0 || r > 7)
          return null;
        return String.fromCharCode(97 + f) + (r + 1);
      };
      if (type === "p") {
        const dir = color === "w" ? 1 : -1;
        const startRank = color === "w" ? 1 : 6;
        const f1 = sqAt(file, rank + dir);
        if (f1 && !chess.get(f1))
          out.push(f1);
        const f2 = sqAt(file, rank + 2 * dir);
        if (rank === startRank && f1 && f2 && !chess.get(f1) && !chess.get(f2)) {
          out.push(f2);
        }
        for (const dx of [-1, 1]) {
          const c = sqAt(file + dx, rank + dir);
          if (!c)
            continue;
          const t = chess.get(c);
          if (t && t.color === enemy)
            out.push(c);
        }
        return out;
      }
      if (type === "n") {
        for (const [dx, dy] of [
          [1, 2],
          [1, -2],
          [-1, 2],
          [-1, -2],
          [2, 1],
          [2, -1],
          [-2, 1],
          [-2, -1]
        ]) {
          const c = sqAt(file + dx, rank + dy);
          if (!c)
            continue;
          const t = chess.get(c);
          if (t && t.color === color)
            continue;
          out.push(c);
        }
        return out;
      }
      const dirs = [];
      if (type === "r" || type === "q")
        dirs.push([0, 1], [0, -1], [1, 0], [-1, 0]);
      if (type === "b" || type === "q")
        dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      for (const [dx, dy] of dirs) {
        let f = file + dx;
        let r = rank + dy;
        while (true) {
          const c = sqAt(f, r);
          if (!c)
            break;
          const t = chess.get(c);
          if (!t) {
            out.push(c);
          } else {
            if (t.color === enemy)
              out.push(c);
            break;
          }
          f += dx;
          r += dy;
        }
      }
      return out;
    }
    function existsTargetOffPinLine(chess, pSq, pType, pColor, attackerSq, anchorSq) {
      const targets = pseudoTargets(chess, pSq, pType, pColor);
      if (targets.length === 0)
        return false;
      const ux = anchorSq.charCodeAt(0) - attackerSq.charCodeAt(0);
      const uy = parseInt(anchorSq[1], 10) - parseInt(attackerSq[1], 10);
      for (const t of targets) {
        const vx = t.charCodeAt(0) - pSq.charCodeAt(0);
        const vy = parseInt(t[1], 10) - parseInt(pSq[1], 10);
        if (ux * vy - uy * vx !== 0)
          return true;
      }
      return false;
    }
  }
});

// packages/shared/dist/chess/fork.js
var require_fork = __commonJS({
  "packages/shared/dist/chess/fork.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.computeForkAnalysisAfterMove = computeForkAnalysisAfterMove;
    exports2.computeForkTargetsAfterMove = computeForkTargetsAfterMove;
    var chess_js_1 = require_chess();
    var PIECE_VALUE = {
      p: 1,
      n: 3,
      b: 3,
      r: 5,
      q: 9,
      k: Infinity
    };
    var VALUABLE_THRESHOLD = 3;
    function collectAttacksByPiece(chess, our, enemy) {
      const out = /* @__PURE__ */ new Map();
      const board = chess.board();
      for (const row of board) {
        for (const piece of row) {
          if (!piece)
            continue;
          if (piece.color !== enemy)
            continue;
          if (PIECE_VALUE[piece.type] < VALUABLE_THRESHOLD)
            continue;
          const attackers = chess.attackers(piece.square, our);
          for (const fSq of attackers) {
            if (!out.has(fSq))
              out.set(fSq, /* @__PURE__ */ new Set());
            out.get(fSq).add(piece.square);
          }
        }
      }
      return out;
    }
    function computeForkAnalysisAfterMove(fen, move) {
      let chess;
      try {
        chess = new chess_js_1.Chess(fen);
      } catch {
        return { clean: null, hasOverlap: false };
      }
      const our = chess.turn();
      const enemy = our === "w" ? "b" : "w";
      const attacksBefore = collectAttacksByPiece(chess, our, enemy);
      try {
        chess.move({
          from: move.from,
          to: move.to,
          promotion: move.promotion
        });
      } catch {
        return { clean: null, hasOverlap: false };
      }
      const attacksAfter = collectAttacksByPiece(chess, our, enemy);
      let clean = null;
      let hasOverlap = false;
      for (const [forkerSq, targets] of attacksAfter) {
        if (targets.size < 2)
          continue;
        const oldSquare = forkerSq === move.to ? move.from : forkerSq;
        const before = attacksBefore.get(oldSquare);
        let overlap = false;
        if (before) {
          for (const t of targets) {
            if (before.has(t)) {
              overlap = true;
              break;
            }
          }
        }
        if (overlap) {
          hasOverlap = true;
        } else if (!clean) {
          clean = { forkerSq, targets: Array.from(targets) };
        }
      }
      chess.undo();
      return { clean, hasOverlap };
    }
    function computeForkTargetsAfterMove(fen, move) {
      return computeForkAnalysisAfterMove(fen, move).clean;
    }
  }
});

// packages/shared/dist/chess/undefended-attack.js
var require_undefended_attack = __commonJS({
  "packages/shared/dist/chess/undefended-attack.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.computeNewThreatsAfterMove = computeNewThreatsAfterMove;
    var chess_js_1 = require_chess();
    function collectUndefendedThreats(chess, our, enemy) {
      const out = /* @__PURE__ */ new Set();
      const board = chess.board();
      for (const row of board) {
        for (const piece of row) {
          if (!piece)
            continue;
          if (piece.color !== enemy)
            continue;
          if (piece.type === "k")
            continue;
          const attackers = chess.attackers(piece.square, our);
          if (attackers.length < 1)
            continue;
          const defenders = chess.attackers(piece.square, enemy);
          if (defenders.length > 0)
            continue;
          out.add(piece.square);
        }
      }
      return out;
    }
    function computeNewThreatsAfterMove(fen, move) {
      let chess;
      try {
        chess = new chess_js_1.Chess(fen);
      } catch {
        return { newThreats: [] };
      }
      const our = chess.turn();
      const enemy = our === "w" ? "b" : "w";
      const threatsBefore = collectUndefendedThreats(chess, our, enemy);
      try {
        chess.move({
          from: move.from,
          to: move.to,
          promotion: move.promotion
        });
      } catch {
        return { newThreats: [] };
      }
      const threatsAfter = collectUndefendedThreats(chess, our, enemy);
      const newThreats = [];
      for (const sq of threatsAfter) {
        if (!threatsBefore.has(sq))
          newThreats.push(sq);
      }
      chess.undo();
      return { newThreats };
    }
  }
});

// packages/shared/dist/chess/index.js
var require_chess2 = __commonJS({
  "packages/shared/dist/chess/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_pin(), exports2);
    __exportStar(require_fork(), exports2);
    __exportStar(require_undefended_attack(), exports2);
  }
});

// packages/shared/dist/broadcast-pgn/pgn-parser.js
var require_pgn_parser = __commonJS({
  "packages/shared/dist/broadcast-pgn/pgn-parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.STARTING_FEN = void 0;
    exports2.parseElo = parseElo;
    exports2.computeFenAndLastUci = computeFenAndLastUci;
    exports2.extractLichessGameId = extractLichessGameId;
    exports2.extractClocksFromPgn = extractClocksFromPgn;
    exports2.parsePgnGames = parsePgnGames;
    exports2.findDuplicateGameIds = findDuplicateGameIds;
    var chess_js_1 = require_chess();
    exports2.STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    function parseElo(raw) {
      if (!raw)
        return null;
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "?" || trimmed === "-")
        return null;
      const n = parseInt(trimmed, 10);
      if (isNaN(n) || n <= 0 || n > 4e3)
        return null;
      return n;
    }
    function computeFenAndLastUci(pgnText) {
      const cleaned = pgnText.replace(/\{[^}]*\}/g, "");
      try {
        const chess = new chess_js_1.Chess();
        chess.loadPgn(cleaned);
        const history = chess.history({ verbose: true });
        if (history.length > 0) {
          const last = history[history.length - 1];
          const uci = last.from + last.to + (last.promotion ?? "");
          return { fen: chess.fen(), lastUci: uci };
        }
      } catch {
      }
      return { fen: null, lastUci: "" };
    }
    function extractLichessGameId(headerMap) {
      const gameUrl = headerMap["GameURL"] ?? "";
      const site = headerMap["Site"] ?? "";
      const roundTag = headerMap["Round"] ?? "";
      const urlSource = gameUrl || (site.includes("/") ? site : "");
      if (urlSource) {
        const id = urlSource.split("/").pop() ?? null;
        if (id)
          return id;
      }
      if (roundTag)
        return `round:${roundTag}`;
      return null;
    }
    function extractClocksFromPgn(pgnSection) {
      const bodyStart = pgnSection.indexOf("\n\n");
      const body = bodyStart >= 0 ? pgnSection.slice(bodyStart + 2) : pgnSection;
      const tokenRe = /(\d+\.+)|(\{[^}]*\})|(\*|1-0|0-1|1\/2-1\/2)|(\$\d+)|(\S+)/g;
      const clkRe = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/;
      let side = "w";
      let whiteMs = null;
      let blackMs = null;
      let lastSideJustMoved = null;
      let m;
      while ((m = tokenRe.exec(body)) !== null) {
        const numToken = m[1];
        const commentToken = m[2];
        const resultToken = m[3];
        const nagToken = m[4];
        const moveToken = m[5];
        if (resultToken)
          break;
        if (numToken) {
          const dots = numToken.replace(/\d/g, "").length;
          side = dots >= 3 ? "b" : "w";
          continue;
        }
        if (commentToken) {
          if (lastSideJustMoved == null)
            continue;
          const c = clkRe.exec(commentToken);
          if (!c)
            continue;
          const h = parseInt(c[1], 10);
          const min = parseInt(c[2], 10);
          const s = parseFloat(c[3]);
          if (Number.isNaN(h) || Number.isNaN(min) || Number.isNaN(s))
            continue;
          const ms = Math.round((h * 3600 + min * 60 + s) * 1e3);
          if (lastSideJustMoved === "w")
            whiteMs = ms;
          else
            blackMs = ms;
          continue;
        }
        if (nagToken) {
          continue;
        }
        if (moveToken) {
          lastSideJustMoved = side;
          side = side === "w" ? "b" : "w";
        }
      }
      return { whiteMs, blackMs };
    }
    function parsePgnGames(rawPgn) {
      const cleanedPgn = rawPgn.split("\n").filter((line) => {
        const trimmed = line.trim();
        if (!trimmed)
          return true;
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            JSON.parse(trimmed);
            return false;
          } catch {
            return true;
          }
        }
        return true;
      }).join("\n");
      const gameSections = cleanedPgn.split(/\n\n(?=\[)/);
      const games = [];
      let index = 0;
      for (const section of gameSections) {
        if (!section.trim())
          continue;
        const headerMap = {};
        const headerLines = section.match(/\[(\w+)\s+"([^"]*)"\]/g) ?? [];
        if (headerLines.length === 0)
          continue;
        for (const line of headerLines) {
          const m = line.match(/\[(\w+)\s+"([^"]*)"\]/);
          if (m)
            headerMap[m[1]] = m[2];
        }
        const fenValue = headerMap["FEN"] ?? "";
        const white = headerMap["White"] ?? "Unknown";
        const black = headerMap["Black"] ?? "Unknown";
        const whiteElo = parseElo(headerMap["WhiteElo"]);
        const blackElo = parseElo(headerMap["BlackElo"]);
        const result = headerMap["Result"] ?? "";
        const lastMove = headerMap["LastMove"] ?? "";
        const lichessGameId = extractLichessGameId(headerMap);
        const { fen: computedFen, lastUci } = computeFenAndLastUci(section);
        const fen = fenValue || computedFen || exports2.STARTING_FEN;
        const uci = lastMove || lastUci;
        const { whiteMs, blackMs } = extractClocksFromPgn(section);
        games.push({
          index,
          white,
          black,
          whiteElo,
          blackElo,
          result,
          fen,
          uci,
          pgn: section.trim(),
          lichessGameId,
          whiteClockMs: whiteMs,
          blackClockMs: blackMs
        });
        index++;
      }
      return games;
    }
    function findDuplicateGameIds(games) {
      const counts = /* @__PURE__ */ new Map();
      for (const g of games) {
        if (g.lichessGameId === null)
          continue;
        counts.set(g.lichessGameId, (counts.get(g.lichessGameId) ?? 0) + 1);
      }
      const dupes = [];
      for (const [id, n] of counts) {
        if (n > 1)
          dupes.push(id);
      }
      return dupes;
    }
  }
});

// packages/shared/dist/broadcast-pgn/index.js
var require_broadcast_pgn = __commonJS({
  "packages/shared/dist/broadcast-pgn/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_pgn_parser(), exports2);
  }
});

// packages/shared/dist/features-catalog/home.js
var require_home = __commonJS({
  "packages/shared/dist/features-catalog/home.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.home = void 0;
    exports2.home = {
      id: "home",
      title: "Home and platform overview",
      paths: ["/", "/features"],
      summary: "Landing entry point: signed-in users are sent to the play hub, guests see a feature overview of the platform.",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/play.js
var require_play = __commonJS({
  "packages/shared/dist/features-catalog/play.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.play = void 0;
    exports2.play = {
      id: "play",
      title: "Play (matchmaking and bot)",
      paths: ["/play"],
      summary: "Primary screen for starting a game: matchmaking against real players or play against the Stockfish bot, configured side by side.",
      auth: "user",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/active-game.js
var require_active_game = __commonJS({
  "packages/shared/dist/features-catalog/active-game.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.activeGame = void 0;
    exports2.activeGame = {
      id: "active-game",
      title: "Active game and post-game review",
      paths: ["/game/:id", "/game/:gameId/review"],
      summary: "Live board for a game in progress and the post-game review screen that opens after the game ends (available for both human and bot games).",
      auth: "optional",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/games-live.js
var require_games_live = __commonJS({
  "packages/shared/dist/features-catalog/games-live.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.gamesLive = void 0;
    exports2.gamesLive = {
      id: "games-live",
      title: "Watch live games",
      paths: ["/games/live", "/games/:id/watch"],
      summary: "Spectator lobby and per-game read-only board for watching games currently in progress on the platform.",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/puzzles.js
var require_puzzles = __commonJS({
  "packages/shared/dist/features-catalog/puzzles.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.puzzles = void 0;
    exports2.puzzles = {
      id: "puzzles",
      title: "Puzzles",
      paths: ["/puzzles", "/puzzle", "/puzzle/:id", "/puzzles/stats"],
      summary: "Classic tactical puzzles set sourced from Lichess; solving updates a per-user puzzle rating (Glicko-2) and a streak. The newer engine-generated training lives separately on /precision.",
      auth: "optional",
      featureFlag: "puzzlesEnabled",
      mcpSection: "puzzles"
    };
  }
});

// packages/shared/dist/features-catalog/puzzle-rush.js
var require_puzzle_rush = __commonJS({
  "packages/shared/dist/features-catalog/puzzle-rush.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.puzzleRush = void 0;
    exports2.puzzleRush = {
      id: "puzzle-rush",
      title: "Puzzle Rush",
      paths: [
        "/puzzle-rush",
        "/puzzle-rush/leaderboard",
        "/puzzle-rush/review/:scoreId"
      ],
      summary: "Speed-solving mode where the user solves as many puzzles as possible against a 3-minute or 5-minute timer with three lives.",
      auth: "optional",
      featureFlag: null,
      mcpSection: "puzzle_rush"
    };
  }
});

// packages/shared/dist/features-catalog/precision.js
var require_precision = __commonJS({
  "packages/shared/dist/features-catalog/precision.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.precision = void 0;
    exports2.precision = {
      id: "precision",
      title: "Precision Training",
      paths: [
        "/precision",
        "/precision/stats",
        "/precision/history",
        "/precision/attempts/:id"
      ],
      summary: "5-star training on engine-generated puzzles in two genres (realize the advantage / hold the draw), measuring WDL-loss vs the engine on each user move; tracks per-attempt stars and history.",
      auth: "user",
      featureFlag: "puzzlesEnabled",
      adr: [
        "ADR-047",
        "ADR-048",
        "ADR-055",
        "ADR-056",
        "ADR-057",
        "ADR-065",
        "ADR-066",
        "ADR-068",
        "ADR-069",
        "ADR-070"
      ],
      mcpSection: "puzzles"
    };
  }
});

// packages/shared/dist/features-catalog/mistakes.js
var require_mistakes = __commonJS({
  "packages/shared/dist/features-catalog/mistakes.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.mistakes = void 0;
    exports2.mistakes = {
      id: "mistakes",
      title: "Mistakes practice",
      paths: ["/puzzles/mistakes", "/puzzles/mistakes-practice"],
      summary: "Personalized practice on positions where the user previously erred, sourced from failed puzzles and blunders detected during game review.",
      auth: "user",
      featureFlag: "puzzlesEnabled",
      mcpSection: "puzzles"
    };
  }
});

// packages/shared/dist/features-catalog/analysis.js
var require_analysis = __commonJS({
  "packages/shared/dist/features-catalog/analysis.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.analysis = void 0;
    exports2.analysis = {
      id: "analysis",
      title: "Analysis board",
      paths: ["/analysis", "/analysis/:id", "/analysis/public/:id"],
      summary: "Analysis board for arbitrary positions or PGNs with engine evaluation, variations, NAG annotations, and optional image-to-FEN to set a position from a board photo or screenshot.",
      auth: "optional",
      featureFlag: null,
      adr: ["ADR-040"],
      mcpSection: "analyses"
    };
  }
});

// packages/shared/dist/features-catalog/workshop.js
var require_workshop = __commonJS({
  "packages/shared/dist/features-catalog/workshop.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.workshop = void 0;
    exports2.workshop = {
      id: "workshop",
      title: "Workshop",
      paths: ["/workshop", "/workshop/pgn-files", "/workshop/pgn-files/:fileId"],
      summary: "Personal library of saved analyses and uploaded PGN files, with browsing of individual games inside each file.",
      auth: "user",
      featureFlag: null,
      mcpSection: "workshop"
    };
  }
});

// packages/shared/dist/features-catalog/drills.js
var require_drills = __commonJS({
  "packages/shared/dist/features-catalog/drills.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.drills = void 0;
    exports2.drills = {
      id: "drills",
      title: "Drills (tactical trainers)",
      paths: [
        "/drills",
        "/drills/about",
        "/drills/sprint",
        "/drills/sprint/play",
        "/drills/sprint/results",
        "/drills/sprint/leaderboard",
        "/drills/:type"
      ],
      summary: "Focused tactical trainers grouped by drill type (mating patterns, endgames, calculation), plus a Sprint mode with a leaderboard.",
      auth: "optional",
      featureFlag: "drillsEnabled",
      adr: ["ADR-035"],
      mcpSection: "tactic_drills"
    };
  }
});

// packages/shared/dist/features-catalog/lessons.js
var require_lessons2 = __commonJS({
  "packages/shared/dist/features-catalog/lessons.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.lessons = void 0;
    exports2.lessons = {
      id: "lessons",
      title: "Lessons (courses)",
      paths: [
        "/lessons",
        "/lessons/my-active",
        "/lessons/discover",
        "/lessons/editor",
        "/lessons/my/:slug/edit",
        "/lessons/:courseSlug",
        "/lessons/:courseSlug/:lessonSlug"
      ],
      summary: "Structured chess courses authored on the platform: each course is a sequence of lessons combining text, board positions, and exercises.",
      auth: "optional",
      featureFlag: "lessonsEnabled",
      mcpSection: "lessons"
    };
  }
});

// packages/shared/dist/features-catalog/tournaments.js
var require_tournaments = __commonJS({
  "packages/shared/dist/features-catalog/tournaments.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.tournaments = void 0;
    exports2.tournaments = {
      id: "tournaments",
      title: "Tournaments",
      paths: ["/tournaments", "/tournaments/:id", "/arena/:id"],
      summary: "Tournaments in three formats \u2014 Arena, Swiss, and Round Robin \u2014 with filters by status and time control; users can create or join.",
      auth: "optional",
      featureFlag: "tournamentsEnabled",
      mcpSection: "tournaments"
    };
  }
});

// packages/shared/dist/features-catalog/broadcasts.js
var require_broadcasts = __commonJS({
  "packages/shared/dist/features-catalog/broadcasts.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.broadcasts = void 0;
    exports2.broadcasts = {
      id: "broadcasts",
      title: "Broadcasts",
      paths: [
        "/broadcasts",
        "/broadcasts/:tournamentId",
        "/broadcasts/:tournamentId/:roundId",
        "/broadcasts/:tournamentId/:roundId/:gameId",
        "/broadcasts/:tournamentId/:roundId/:gameId/live"
      ],
      summary: "Live relay of major chess events (FIDE Candidates, World Championship, Olympiad, etc.) sourced from the Lichess broadcast integration.",
      auth: "public",
      featureFlag: "broadcastsEnabled",
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/players.js
var require_players = __commonJS({
  "packages/shared/dist/features-catalog/players.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.players = void 0;
    exports2.players = {
      id: "players",
      title: "Players",
      paths: ["/players", "/player/:username"],
      summary: "Player directory and public player profiles with username search, ratings per time control, online status, and game history.",
      auth: "public",
      featureFlag: null,
      mcpSection: "players"
    };
  }
});

// packages/shared/dist/features-catalog/friends.js
var require_friends = __commonJS({
  "packages/shared/dist/features-catalog/friends.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.friends = void 0;
    exports2.friends = {
      id: "friends",
      title: "Friends",
      paths: ["/friends"],
      summary: "Friends list with online status and ratings; send, accept, or decline friend requests and challenge friends to a game.",
      auth: "user",
      featureFlag: null,
      mcpSection: "friends"
    };
  }
});

// packages/shared/dist/features-catalog/messages.js
var require_messages = __commonJS({
  "packages/shared/dist/features-catalog/messages.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.messages = void 0;
    exports2.messages = {
      id: "messages",
      title: "Messages",
      paths: ["/messages", "/messages/:userId"],
      summary: "Direct messaging between users with a conversation list, message history, and real-time delivery.",
      auth: "user",
      featureFlag: null,
      mcpSection: "messages"
    };
  }
});

// packages/shared/dist/features-catalog/profile.js
var require_profile = __commonJS({
  "packages/shared/dist/features-catalog/profile.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.profile = void 0;
    exports2.profile = {
      id: "profile",
      title: "Profile (your own)",
      paths: ["/profile"],
      summary: "Shortcut entry that redirects to the user's own public player profile (ratings, game history, link to settings).",
      auth: "user",
      featureFlag: null,
      mcpSection: "users"
    };
  }
});

// packages/shared/dist/features-catalog/settings.js
var require_settings = __commonJS({
  "packages/shared/dist/features-catalog/settings.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.settings = void 0;
    exports2.settings = {
      id: "settings",
      title: "Settings",
      paths: ["/settings"],
      summary: "Account settings page: profile basics, language, board theme and pieces, animation speed, sound, external account display, blocked users.",
      auth: "user",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/feedback.js
var require_feedback = __commonJS({
  "packages/shared/dist/features-catalog/feedback.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.feedback = void 0;
    exports2.feedback = {
      id: "feedback",
      title: "Feedback board",
      paths: ["/feedback", "/feedback/:id"],
      summary: "Community feedback board where users submit bug reports, suggestions, and questions, vote on existing posts, and comment.",
      auth: "optional",
      featureFlag: null,
      mcpSection: "feedback"
    };
  }
});

// packages/shared/dist/features-catalog/archive.js
var require_archive3 = __commonJS({
  "packages/shared/dist/features-catalog/archive.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.archive = void 0;
    exports2.archive = {
      id: "archive",
      title: "Archive (external games and players)",
      paths: ["/archive", "/archive/games/:id", "/archive/players/:slug"],
      summary: "Searchable archive of professional/master-level tournament games imported weekly from TWIC, with filters by player and opening and a position search (paste a FEN or upload a board image).",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/train-lobby.js
var require_train_lobby = __commonJS({
  "packages/shared/dist/features-catalog/train-lobby.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.trainLobby = void 0;
    exports2.trainLobby = {
      id: "train-lobby",
      title: "Training hub",
      paths: ["/train"],
      summary: "Hub page that aggregates training modes (puzzles, puzzle rush, precision, drills, mistakes, lessons) for the user to pick from one screen.",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/analyze-lobby.js
var require_analyze_lobby = __commonJS({
  "packages/shared/dist/features-catalog/analyze-lobby.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.analyzeLobby = void 0;
    exports2.analyzeLobby = {
      id: "analyze-lobby",
      title: "Analysis hub",
      paths: ["/analyze"],
      summary: "Hub page that aggregates analysis-oriented sections (analysis board, workshop, archive) for picking how to start a session.",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/docs.js
var require_docs = __commonJS({
  "packages/shared/dist/features-catalog/docs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.docs = void 0;
    exports2.docs = {
      id: "docs",
      title: "Documentation pages",
      paths: ["/docs/user-courses", "/help/external-engine"],
      summary: "In-app documentation pages with user-facing help for authoring user courses and connecting an external chess engine to the analysis board.",
      auth: "public",
      featureFlag: null,
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/ai-chat.js
var require_ai_chat = __commonJS({
  "packages/shared/dist/features-catalog/ai-chat.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.aiChat = void 0;
    exports2.aiChat = {
      id: "ai-chat",
      title: "AI Chat Assistant",
      paths: [],
      summary: "This is YOU \u2014 the in-site AI assistant rendered as a chat widget; you help users navigate the site and look up their data via tools.",
      auth: "optional",
      featureFlag: "assistantEnabled",
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/board-recognition.js
var require_board_recognition = __commonJS({
  "packages/shared/dist/features-catalog/board-recognition.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.boardRecognition = void 0;
    exports2.boardRecognition = {
      id: "board-recognition",
      title: "Board recognition (image \u2192 FEN)",
      paths: [],
      summary: "Cross-cutting capability that converts a board photo or screenshot to a FEN string; available inside Analysis and Archive position search when a recognition model is installed.",
      auth: "user",
      featureFlag: null,
      adr: ["ADR-040"],
      mcpSection: null
    };
  }
});

// packages/shared/dist/features-catalog/types.js
var require_types = __commonJS({
  "packages/shared/dist/features-catalog/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// packages/shared/dist/features-catalog/index.js
var require_features_catalog = __commonJS({
  "packages/shared/dist/features-catalog/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.FEATURES = void 0;
    var home_js_1 = require_home();
    var play_js_1 = require_play();
    var active_game_js_1 = require_active_game();
    var games_live_js_1 = require_games_live();
    var puzzles_js_1 = require_puzzles();
    var puzzle_rush_js_1 = require_puzzle_rush();
    var precision_js_1 = require_precision();
    var mistakes_js_1 = require_mistakes();
    var analysis_js_1 = require_analysis();
    var workshop_js_1 = require_workshop();
    var drills_js_1 = require_drills();
    var lessons_js_1 = require_lessons2();
    var tournaments_js_1 = require_tournaments();
    var broadcasts_js_1 = require_broadcasts();
    var players_js_1 = require_players();
    var friends_js_1 = require_friends();
    var messages_js_1 = require_messages();
    var profile_js_1 = require_profile();
    var settings_js_1 = require_settings();
    var feedback_js_1 = require_feedback();
    var archive_js_1 = require_archive3();
    var train_lobby_js_1 = require_train_lobby();
    var analyze_lobby_js_1 = require_analyze_lobby();
    var docs_js_1 = require_docs();
    var ai_chat_js_1 = require_ai_chat();
    var board_recognition_js_1 = require_board_recognition();
    __exportStar(require_types(), exports2);
    exports2.FEATURES = [
      home_js_1.home,
      play_js_1.play,
      active_game_js_1.activeGame,
      games_live_js_1.gamesLive,
      puzzles_js_1.puzzles,
      puzzle_rush_js_1.puzzleRush,
      precision_js_1.precision,
      mistakes_js_1.mistakes,
      analysis_js_1.analysis,
      workshop_js_1.workshop,
      drills_js_1.drills,
      lessons_js_1.lessons,
      tournaments_js_1.tournaments,
      broadcasts_js_1.broadcasts,
      players_js_1.players,
      friends_js_1.friends,
      messages_js_1.messages,
      profile_js_1.profile,
      settings_js_1.settings,
      feedback_js_1.feedback,
      archive_js_1.archive,
      train_lobby_js_1.trainLobby,
      analyze_lobby_js_1.analyzeLobby,
      docs_js_1.docs,
      ai_chat_js_1.aiChat,
      board_recognition_js_1.boardRecognition
    ];
  }
});

// packages/shared/dist/index.js
var require_dist = __commonJS({
  "packages/shared/dist/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_game(), exports2);
    __exportStar(require_user(), exports2);
    __exportStar(require_puzzle(), exports2);
    __exportStar(require_puzzle_gen(), exports2);
    __exportStar(require_lessons(), exports2);
    __exportStar(require_user_courses(), exports2);
    __exportStar(require_video_url(), exports2);
    __exportStar(require_api_contracts(), exports2);
    __exportStar(require_feature_flags(), exports2);
    __exportStar(require_synthetic(), exports2);
    __exportStar(require_internal_auth(), exports2);
    __exportStar(require_tactic_drill(), exports2);
    __exportStar(require_tactic_puzzle(), exports2);
    __exportStar(require_blog(), exports2);
    __exportStar(require_saved_filters(), exports2);
    __exportStar(require_opening_trainer(), exports2);
    __exportStar(require_live_analysis(), exports2);
    __exportStar(require_lecture_chat(), exports2);
    __exportStar(require_positional_trace(), exports2);
    __exportStar(require_metrics_comment(), exports2);
    __exportStar(require_prerender_task(), exports2);
    __exportStar(require_lecture_replay(), exports2);
    __exportStar(require_buildMoveTimestampIndex(), exports2);
    __exportStar(require_synthetic_chat_phrases(), exports2);
    __exportStar(require_constants(), exports2);
    __exportStar(require_archive2(), exports2);
    __exportStar(require_hint_anchors(), exports2);
    __exportStar(require_hint_payload(), exports2);
    __exportStar(require_hint_templating(), exports2);
    __exportStar(require_hint_quiet_pages(), exports2);
    __exportStar(require_event_catalog(), exports2);
    __exportStar(require_time_control(), exports2);
    __exportStar(require_fen_key(), exports2);
    __exportStar(require_archive_name_normalize(), exports2);
    __exportStar(require_wdl(), exports2);
    __exportStar(require_puzzle_gen_core(), exports2);
    __exportStar(require_puzzle_gen_pipeline(), exports2);
    __exportStar(require_tactic_puzzle_gen(), exports2);
    __exportStar(require_move_classification(), exports2);
    __exportStar(require_precision_score(), exports2);
    __exportStar(require_guess_move(), exports2);
    __exportStar(require_move_gen(), exports2);
    __exportStar(require_precision_themes(), exports2);
    __exportStar(require_chess2(), exports2);
    __exportStar(require_broadcast_pgn(), exports2);
    __exportStar(require_features_catalog(), exports2);
  }
});

// packages/maia-core/dist/annotate.js
var require_annotate = __commonJS({
  "packages/maia-core/dist/annotate.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.annotateWeakChoice = annotateWeakChoice;
    var shared_1 = require_dist();
    var weak_choice_js_1 = require_weak_choice();
    var DEFAULT_SF_DEPTH = 15;
    async function annotateWeakChoice(args2) {
      const { fen, firstMovePV1, maia, engine, elo } = args2;
      const sfDepth = args2.sfDepth ?? DEFAULT_SF_DEPTH;
      const maiaResult = await maia.predictMoves(fen, elo, elo);
      if (maiaResult.policy.length === 0)
        return null;
      const { searchMoves } = (0, weak_choice_js_1.buildMaiaSearchMoves)(maiaResult.policy, firstMovePV1);
      if (searchMoves.length === 0) {
        return {
          weakChoiceProb: 0,
          metricVersion: weak_choice_js_1.MAIA_WEAK_CHOICE_METRIC_VERSION,
          elo
        };
      }
      const lines = await engine.analyzeWithWdl(fen, {
        depth: sfDepth,
        multiPV: searchMoves.length,
        searchMoves
      });
      const expectedScores = /* @__PURE__ */ new Map();
      for (const line of lines) {
        const wdl = (0, shared_1.wdlOrMateFallback)(line.wdl, line.score);
        if (!wdl)
          continue;
        expectedScores.set(line.bestMove, (0, shared_1.expectedScoreFromWdl)(wdl));
      }
      const result = (0, weak_choice_js_1.computeWeakChoiceProb)({
        policy: maiaResult.policy,
        firstMovePV1,
        expectedScores
      });
      return {
        weakChoiceProb: result.weakChoiceProb,
        metricVersion: weak_choice_js_1.MAIA_WEAK_CHOICE_METRIC_VERSION,
        elo
      };
    }
  }
});

// packages/maia-core/dist/index.js
var require_dist2 = __commonJS({
  "packages/maia-core/dist/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.annotateWeakChoice = exports2.weakWeight = exports2.computeWeakChoiceProb = exports2.buildMaiaSearchMoves = exports2.WEAK_LOSS_E_THRESHOLD = exports2.WEAK_LOSS_E_SOFT_WIDTH = exports2.WEAK_LOSS_E_CENTER = exports2.MAIA_WEAK_CHOICE_METRIC_VERSION = exports2.MAIA_TOP_K_POLICY_THRESHOLD = exports2.MAIA_TOP_K_MAX = exports2.loadModelFromFs = exports2.createNodeProvider = exports2.preprocessMaia3 = exports2.mirrorMove = exports2.allPossibleMovesMaia3Reversed = exports2.allPossibleMovesMaia3 = exports2.MAIA3_MOVE_VOCAB_SIZE = exports2.postprocessMaia3 = exports2.Maia = void 0;
    var engine_js_1 = require_engine();
    Object.defineProperty(exports2, "Maia", { enumerable: true, get: function() {
      return engine_js_1.Maia;
    } });
    Object.defineProperty(exports2, "postprocessMaia3", { enumerable: true, get: function() {
      return engine_js_1.postprocessMaia3;
    } });
    var tensor_js_1 = require_tensor();
    Object.defineProperty(exports2, "MAIA3_MOVE_VOCAB_SIZE", { enumerable: true, get: function() {
      return tensor_js_1.MAIA3_MOVE_VOCAB_SIZE;
    } });
    Object.defineProperty(exports2, "allPossibleMovesMaia3", { enumerable: true, get: function() {
      return tensor_js_1.allPossibleMovesMaia3;
    } });
    Object.defineProperty(exports2, "allPossibleMovesMaia3Reversed", { enumerable: true, get: function() {
      return tensor_js_1.allPossibleMovesMaia3Reversed;
    } });
    Object.defineProperty(exports2, "mirrorMove", { enumerable: true, get: function() {
      return tensor_js_1.mirrorMove;
    } });
    Object.defineProperty(exports2, "preprocessMaia3", { enumerable: true, get: function() {
      return tensor_js_1.preprocessMaia3;
    } });
    var node_provider_js_1 = require_node_provider();
    Object.defineProperty(exports2, "createNodeProvider", { enumerable: true, get: function() {
      return node_provider_js_1.createNodeProvider;
    } });
    Object.defineProperty(exports2, "loadModelFromFs", { enumerable: true, get: function() {
      return node_provider_js_1.loadModelFromFs;
    } });
    var weak_choice_js_1 = require_weak_choice();
    Object.defineProperty(exports2, "MAIA_TOP_K_MAX", { enumerable: true, get: function() {
      return weak_choice_js_1.MAIA_TOP_K_MAX;
    } });
    Object.defineProperty(exports2, "MAIA_TOP_K_POLICY_THRESHOLD", { enumerable: true, get: function() {
      return weak_choice_js_1.MAIA_TOP_K_POLICY_THRESHOLD;
    } });
    Object.defineProperty(exports2, "MAIA_WEAK_CHOICE_METRIC_VERSION", { enumerable: true, get: function() {
      return weak_choice_js_1.MAIA_WEAK_CHOICE_METRIC_VERSION;
    } });
    Object.defineProperty(exports2, "WEAK_LOSS_E_CENTER", { enumerable: true, get: function() {
      return weak_choice_js_1.WEAK_LOSS_E_CENTER;
    } });
    Object.defineProperty(exports2, "WEAK_LOSS_E_SOFT_WIDTH", { enumerable: true, get: function() {
      return weak_choice_js_1.WEAK_LOSS_E_SOFT_WIDTH;
    } });
    Object.defineProperty(exports2, "WEAK_LOSS_E_THRESHOLD", { enumerable: true, get: function() {
      return weak_choice_js_1.WEAK_LOSS_E_THRESHOLD;
    } });
    Object.defineProperty(exports2, "buildMaiaSearchMoves", { enumerable: true, get: function() {
      return weak_choice_js_1.buildMaiaSearchMoves;
    } });
    Object.defineProperty(exports2, "computeWeakChoiceProb", { enumerable: true, get: function() {
      return weak_choice_js_1.computeWeakChoiceProb;
    } });
    Object.defineProperty(exports2, "weakWeight", { enumerable: true, get: function() {
      return weak_choice_js_1.weakWeight;
    } });
    var annotate_js_1 = require_annotate();
    Object.defineProperty(exports2, "annotateWeakChoice", { enumerable: true, get: function() {
      return annotate_js_1.annotateWeakChoice;
    } });
  }
});

// tools/maia-cli.mjs
var import_node_path = require("node:path");
var import_maia_core = __toESM(require_dist2(), 1);
var args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
async function main() {
  const fen = opt("fen", null);
  const elo = parseInt(opt("elo", "1500"), 10);
  const top = parseInt(opt("top", "5"), 10);
  if (!fen) {
    console.error('\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u0438\u0435: maia-cli --fen "<FEN>" [--elo 1500] [--top 5]');
    process.exit(2);
  }
  const modelPath = process.env.MAIA_MODEL || (0, import_node_path.resolve)(__dirname, "model.onnx");
  const maia = new import_maia_core.Maia({
    provider: (0, import_maia_core.createNodeProvider)(),
    fetchBuffer: () => (0, import_maia_core.loadModelFromFs)(modelPath)
  });
  const { policy, winProbability } = await maia.predictMoves(fen, elo, elo);
  const topMoves = policy.slice(0, top).map((p) => ({
    move: p.move,
    probability: Math.round(p.probability * 1e4) / 1e4
  }));
  console.log(JSON.stringify({ fen, elo, winProbability, top: topMoves }, null, 2));
}
main().catch((e) => {
  console.error("maia-cli error:", e.message);
  process.exit(1);
});
/*! Bundled license information:

chess.js/dist/cjs/chess.js:
  (**
   * @license
   * Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
   * All rights reserved.
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice,
   *    this list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the documentation
   *    and/or other materials provided with the distribution.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
   * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
   * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
   * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
   * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
   * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
   * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
   * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
   * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
   * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
   * POSSIBILITY OF SUCH DAMAGE.
   *)
*/
