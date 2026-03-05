<?php
/**
 * Plugin Name: WP LaunchGuard
 * Description: Connect your WordPress site to LaunchGuard cloud scanning and white-label report management.
 * Version: 0.1.2
 * Author: WP LaunchGuard
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * Text Domain: wplaunchguard
 */

if (!defined('ABSPATH')) {
    exit;
}

define('WPLG_VERSION', '0.1.2');
define('WPLG_PLUGIN_FILE', __FILE__);
define('WPLG_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('WPLG_PLUGIN_URL', plugin_dir_url(__FILE__));

require_once WPLG_PLUGIN_DIR . 'includes/class-wplg-plugin.php';

WPLG_Plugin::instance();
