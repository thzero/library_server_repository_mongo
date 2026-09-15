// Rules earned their place: each one catches a defect found in this codebase.
// See AUDIT_SERVER.md in the parent workspace for the catalogue.
export default [
	{
		files: ['**/*.js'],
		ignores: ['node_modules/**', 'dist/**'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				// library_common installs these onto the global String
				String: 'writable',
				console: 'readonly',
				process: 'readonly',
				performance: 'readonly',
				navigator: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly'
			}
		},
		rules: {
			// undeclared identifiers - caught MomentUtility in utility/checksum.js
			// and cmd in library_cli_build/boot/cli.js
			'no-undef': 'error',
			// === NaN is always false - caught the --major validation in cli.js
			'use-isnan': 'error',
			// Unused locals. This is what caught the loop variable in
			// `for (const value of values) valid &= values`.
			// args is 'none' deliberately: the codebase is built on abstract base
			// classes whose methods declare a signature for subclasses and use none
			// of it - 58 such parameters in library_common_service alone. Dead
			// trailing parameters (idName, index) need a targeted read, not this rule.
			'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
			// the &= boolean accumulator in the _enforce* block
			'no-bitwise': 'error',
			// C17
			'eqeqeq': 'error',
			'no-dupe-class-members': 'error',
			'no-dupe-keys': 'error',
			'no-unreachable': 'error',
			'no-constant-condition': ['error', { checkLoops: false }],
			'no-self-compare': 'error',
			// the comma operator - caught `this._logger.exception(a, b, err), correlationId;`
			// in library_server_messaging_slack, which silently dropped the correlationId
			'no-sequences': 'error',
			// caught `catch (err) { throw err; }` in library_server_repository_redis
			'no-useless-catch': 'error',
			// caught `resource.authentication = resource.authentication;` in
			// library_server_service_rest_axios
			'no-self-assign': 'error',
			// an expression statement that does nothing is almost always a dropped call
			'no-unused-expressions': 'error'
		}
	},
	{
		files: ['test/**/*.js'],
		languageOptions: {
			globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' }
		}
	}
];
