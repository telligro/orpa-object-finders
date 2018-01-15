module.exports = {
    "extends": "google",
    "parserOptions": {
        "ecmaVersion": 8,
        "sourceType": "module",
        "ecmaFeatures": {
            "jsx": true
        }
    },
    "rules": {
        "max-len": [1, 120, 2],
        "require-jsdoc": ["off"],
        "no-unused-vars": ["warn"],
    }
};