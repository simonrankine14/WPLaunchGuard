<?php

if (!defined('ABSPATH')) {
    exit;
}

require_once BASELINE_PLUGIN_DIR . 'includes/class-baseline-admin.php';

class Baseline_Plugin
{
    private static ?Baseline_Plugin $instance = null;

    public static function instance(): Baseline_Plugin
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct()
    {
        add_action('plugins_loaded', [$this, 'init']);
    }

    public function init(): void
    {
        new Baseline_Admin();
    }
}
