/**
 *  Copyright Telligro Pte Ltd 2017
 *
 *  This file is part of OPAL.
 *
 *  OPAL is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  OPAL is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with OPAL.  If not, see <http://www.gnu.org/licenses/>.
 */

let finderObj = null;
let fo$;
class DOMNodePathStep {
  /**
   * @param {string} value
   * @param {boolean} optimized
   */
  constructor(value, optimized) {
    this.value = value;
    this.optimized = optimized || false;
  }

  /**
   * @override
   * @return {string}
   */
  toString() {
    return this.value;
  }
};
class Finder {
  constructor(doc, identity) {
    if (!finderObj) {
      finderObj = this;
    }
    this.doc = {
      url: doc.location.href,
      identity: identity ? identity : {},

    };

    this.styles = {
      backgroundColor: '',
      highightColor: 'rgb(255,223,170)',
    };
    this.fo$ = jQuery.noConflict();
    fo$ = this.fo$;
    finderObj = this;
    return finderObj;
  }

  start(onFound) {
    window.finderStopped = false;
    fo$(document).on('click.finder', (clickEvt) => {
      console.log('R-Clicked With Control %s', clickEvt.ctrlKey);
      if (clickEvt.ctrlKey) {
        clickEvt.preventDefault();
        return false;
      }
    });
    fo$(document).on('mouseover.finder', (mouseEvt) => {
      finderObj.highlight(mouseEvt.target);
    });
    fo$(document).on('mouseout.finder', (mouseEvt) => {
      finderObj.highlight(mouseEvt.target, true);
    });
    fo$(document).on('mousedown.finder', (clickEvt) => {
      // console.log('MouseDown With Control %s', clickEvt.ctrlKey);
      if (!clickEvt.ctrlKey) {
        return;
      }
      // console.log('Element Selected');
      const foundEvt = {
        target: {
        },
      };
      foundEvt.target.xpath = finderObj.xPath(clickEvt.target, true);
      foundEvt.target.xpathFull = finderObj.xPath(clickEvt.target, false);
      foundEvt.target.framePath = finderObj.getFramePath(clickEvt.target);
      foundEvt.target.attributes = finderObj.getTargetAttributes(clickEvt.target);
      foundEvt.url = window.location.href;
      // console.log('R-XPath: %s', foundEvt.target.xpath);
      clickEvt.preventDefault();
      onFound.call(onFound, foundEvt);
      return false;
    });
  }

  stop() {
    console.log('Stop EVent Called');
    fo$(document).off('.finder');
    window.finderStopped = true;
  }

  highlight(target, remove) {
    if (remove) {
      fo$(target).css('background-color', finderObj.styles.backgroundColor);
    } else {
      finderObj.styles.backgroundColor = target.style.backgroundColor;// fo$(target).css('background-color');
      fo$(target).css('background-color', finderObj.styles.highightColor);
    }
  }

  getTargetAttributes(elm) {
    let attrs = {};
    fo$.each(fo$(elm)[0].attributes, function(index, attribute) {
      attrs[attribute.name] = attribute.value;
    });
    attrs.child = finderObj.getTargetPreviewAttributes(fo$(elm).children().eq(0));
    attrs.next = finderObj.getTargetPreviewAttributes(fo$(elm).next());
    attrs.prev = finderObj.getTargetPreviewAttributes(fo$(elm).prev());
    attrs.parent = finderObj.getTargetPreviewAttributes(fo$(elm).parent());
    return attrs;
  }

  getTargetPreviewAttributes(elm) {
    const propNames = ['tagName', 'id', 'name', 'class'];
    let pattrs = {};
    if (fo$(elm).length>0) {
      pattrs = finderObj.getProps(elm, propNames);
    }
    return pattrs;
  }

  getProps(elm, propNames) {
    let props = {};
    fo$.each(propNames, (i, propName) => {
      const propVal = fo$(elm).prop(propName);
      if (propVal!==undefined) {
        props[propName] = propVal;
      }
    });
    return props;
  }

  getFramePath(e) {
    let win = (e instanceof Window) ? e : e.ownerDocument.defaultView;
    let framePath;
    if (!win.frameElement) {
      return '';
    }
    let nextPath = finderObj.getFramePath(win.frameElement);
    framePath = nextPath === '' ? nextPath : nextPath + '->';
    framePath += finderObj.xPath(win.frameElement, true);
    return framePath;
  }

  xPath(node, optimized) {
    if (node.nodeType === Node.DOCUMENT_NODE) {
      return '/';
    }

    let steps = [];
    let contextNode = node;
    while (contextNode) {
      let step = this._xPathValue(contextNode, optimized);
      if (!step) {
        break;
      }
      steps.push(step);
      if (step.optimized) {
        break;
      }
      contextNode = contextNode.parentNode;
    }

    steps.reverse();
    return (steps.length && steps[0].optimized ? '' : '/') + steps.join('/');
  }

  _xPathValue(node, optimized) {
    let ownValue;
    let ownIndex = this._xPathIndex(node);
    if (ownIndex === -1) {
      return null;
    }

    switch (node.nodeType) {
      case Node.ELEMENT_NODE:
        if (optimized && node.getAttribute('id')) {
          return new DOMNodePathStep('//*[@id="' + node.getAttribute('id') + '"]', true);
        }
        ownValue = node.localName;
        break;
      case Node.ATTRIBUTE_NODE:
        ownValue = '@' + node.nodeName;
        break;
      case Node.TEXT_NODE:
      case Node.CDATA_SECTION_NODE:
        ownValue = 'text()';
        break;
      case Node.PROCESSING_INSTRUCTION_NODE:
        ownValue = 'processing-instruction()';
        break;
      case Node.COMMENT_NODE:
        ownValue = 'comment()';
        break;
      case Node.DOCUMENT_NODE:
        ownValue = '';
        break;
      default:
        ownValue = '';
        break;
    }

    if (ownIndex > 0) {
      ownValue += '[' + ownIndex + ']';
    }

    return new DOMNodePathStep(ownValue, node.nodeType === Node.DOCUMENT_NODE);
  }

  _xPathIndex(node) {
    function areNodesSimilar(left, right) {
      if (left === right) {
        return true;
      }

      if (left.nodeType === Node.ELEMENT_NODE && right.nodeType === Node.ELEMENT_NODE) {
        return left.localName === right.localName;
      }

      if (left.nodeType === right.nodeType) {
        return true;
      }


      let leftType = left.nodeType === Node.CDATA_SECTION_NODE ? Node.TEXT_NODE : left.nodeType;
      let rightType = right.nodeType === Node.CDATA_SECTION_NODE ? Node.TEXT_NODE : right.nodeType;
      return leftType === rightType;
    }

    let siblings = node.parentNode ? node.parentNode.children : null;
    if (!siblings) {
      return 0;
    }
    let hasSameNamedElements;
    for (let i = 0; i < siblings.length; ++i) {
      if (areNodesSimilar(node, siblings[i]) && siblings[i] !== node) {
        hasSameNamedElements = true;
        break;
      }
    }
    if (!hasSameNamedElements) {
      return 0;
    }
    let ownIndex = 1;
    for (let i = 0; i < siblings.length; ++i) {
      if (areNodesSimilar(node, siblings[i])) {
        if (siblings[i] === node) {
          return ownIndex;
        }
        ++ownIndex;
      }
    }
    return -1;
  }
};


// FIXME: Need to attach license for parts extracted from chrome devtools front-end project below
// Derived from https://github.com/ChromeDevTools/devtools-frontend # devtools-frontend/front_end/components/DOMPresentationUtils.js
