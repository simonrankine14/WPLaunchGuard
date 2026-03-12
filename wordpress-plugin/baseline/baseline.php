<?php
/**
 * Plugin Name: Baseline
 * Description: Connect your WordPress site to Baseline cloud QA and white-label report management.
 * Version: 0.1.23
 * Author: Baseline
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * Text Domain: baseline
 */

if (!defined('ABSPATH')) {
    exit;
}

define('BASELINE_VERSION', '0.1.23');
define('BASELINE_PLUGIN_FILE', __FILE__);
define('BASELINE_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('BASELINE_PLUGIN_URL', plugin_dir_url(__FILE__));

require_once BASELINE_PLUGIN_DIR . 'includes/class-baseline-plugin.php';

Baseline_Plugin::instance();
