<?php

if (!defined('ABSPATH')) {
    exit;
}

class WPLG_Admin
{
    private const OPTION_API_BASE = 'wplg_api_base_url';
    private const OPTION_SITE_TOKEN = 'wplg_site_token';
    private const OPTION_SITE_ID = 'wplg_site_id';
    private const OPTION_TENANT_ID = 'wplg_tenant_id';
    private const OPTION_LAST_SCAN_ID = 'wplg_last_scan_id';
    private const OPTION_DEFAULT_FORM_MODE = 'wplg_default_form_mode';

    public function __construct()
    {
        add_action('admin_menu', [$this, 'register_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_assets']);

        add_action('admin_post_wplg_register_site', [$this, 'handle_register_site']);
        add_action('admin_post_wplg_run_scan', [$this, 'handle_run_scan']);
        add_action('admin_post_wplg_save_branding', [$this, 'handle_save_branding']);
        add_action('admin_post_wplg_start_checkout', [$this, 'handle_start_checkout']);

        add_action('admin_notices', [$this, 'render_admin_notice']);
    }

    public function register_menu(): void
    {
        add_menu_page(
            __('WP LaunchGuard', 'wplaunchguard'),
            __('LaunchGuard', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-dashboard',
            [$this, 'render_dashboard'],
            'dashicons-shield-alt',
            65
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Branding', 'wplaunchguard'),
            __('Branding', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-branding',
            [$this, 'render_branding']
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Billing', 'wplaunchguard'),
            __('Billing', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-billing',
            [$this, 'render_billing']
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Settings', 'wplaunchguard'),
            __('Settings', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-settings',
            [$this, 'render_settings']
        );
    }

    public function register_settings(): void
    {
        register_setting('wplg_settings_group', self::OPTION_API_BASE, [
            'type' => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_SITE_TOKEN, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_SITE_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_TENANT_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_LAST_SCAN_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_DEFAULT_FORM_MODE, [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_form_mode'],
            'default' => 'dry-run'
        ]);
    }

    public function sanitize_form_mode(string $value): string
    {
        return in_array($value, ['dry-run', 'live'], true) ? $value : 'dry-run';
    }

    public function enqueue_assets(string $hook): void
    {
        if (strpos($hook, 'wplaunchguard') === false) {
            return;
        }
        wp_enqueue_style('wplg-admin', WPLG_PLUGIN_URL . 'assets/css/admin.css', [], WPLG_VERSION);
    }

    public function render_admin_notice(): void
    {
        if (!is_admin()) {
            return;
        }

        if (!isset($_GET['page']) || strpos((string) $_GET['page'], 'wplaunchguard') !== 0) {
            return;
        }

        if (!isset($_GET['wplg_notice']) || !isset($_GET['wplg_message'])) {
            return;
        }

        $noticeType = sanitize_text_field((string) $_GET['wplg_notice']);
        $message = sanitize_text_field((string) $_GET['wplg_message']);
        $class = $noticeType === 'success' ? 'notice notice-success' : 'notice notice-error';

        echo '<div class="' . esc_attr($class) . ' is-dismissible"><p>' . esc_html($message) . '</p></div>';
    }

    public function render_dashboard(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);
        $connected = $siteId !== '';
        $autoRefreshActive = false;

        echo '<div class="wrap wplg-wrap">';
        echo '<h1>WP LaunchGuard</h1>';

        if (!$connected) {
            echo '<div class="wplg-card">';
            echo '<h2>Connect This Site</h2>';
            echo '<p>Register this WordPress site with your LaunchGuard API to enable scans and white-label controls.</p>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="wplg_register_site" />';
            wp_nonce_field('wplg_register_site');
            submit_button('Register Site');
            echo '</form>';
            echo '</div>';
            echo '</div>';
            return;
        }

        $limits = $this->fetch_limits($siteId);
        $scans = $this->fetch_scans($siteId, 10);
        $lastScan = $this->fetch_last_scan();

        echo '<div class="wplg-grid">';

        echo '<div class="wplg-card">';
        echo '<h2>Connection</h2>';
        echo '<p><strong>Site ID:</strong> ' . esc_html($siteId) . '</p>';
        echo '<p><strong>Tenant ID:</strong> ' . esc_html($this->get_option(self::OPTION_TENANT_ID)) . '</p>';
        echo '<p><strong>API:</strong> ' . esc_html($this->get_api_base()) . '</p>';
        echo '</div>';

        echo '<div class="wplg-card">';
        echo '<h2>Run Scan</h2>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="wplg_run_scan" />';
        wp_nonce_field('wplg_run_scan');
        echo '<p><label for="wplg_form_mode"><strong>Form Mode</strong></label><br />';
        echo '<select id="wplg_form_mode" name="form_mode">';
        $defaultMode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run');
        echo '<option value="dry-run"' . selected($defaultMode, 'dry-run', false) . '>dry-run</option>';
        echo '<option value="live"' . selected($defaultMode, 'live', false) . '>live</option>';
        echo '</select></p>';
        echo '<p><label for="wplg_sitemap_url"><strong>Sitemap URL (optional)</strong></label><br />';
        echo '<input class="regular-text" type="url" id="wplg_sitemap_url" name="sitemap_url" placeholder="https://example.com/sitemap_index.xml" /></p>';
        submit_button('Start Scan', 'primary', 'submit', false);
        echo '</form>';
        echo '</div>';

        echo '</div>';

        echo '<div class="wplg-grid">';
        echo '<div class="wplg-card">';
        echo '<h2>Plan Usage</h2>';
        if (is_wp_error($limits)) {
            echo '<p>' . esc_html($limits->get_error_message()) . '</p>';
        } else {
            $data = $limits['data'];
            $planId = sanitize_text_field((string) ($data['plan_id'] ?? 'starter'));
            $billingStatus = sanitize_text_field((string) ($data['billing_status'] ?? 'trial'));
            echo '<p><strong>Period:</strong> ' . esc_html((string) ($data['period_key'] ?? 'n/a')) . '</p>';
            echo '<p><strong>Plan:</strong> ' . esc_html($planId) . ' (' . esc_html($billingStatus) . ')</p>';
            echo '<p><strong>Scans:</strong> ' . esc_html((string) ($data['scans_used'] ?? 0)) . ' / ' . esc_html((string) ($data['scans_limit'] ?? 0)) . '</p>';
            echo '<p><strong>Sites Limit:</strong> ' . esc_html((string) ($data['sites_limit'] ?? 0)) . '</p>';
            echo '<p><a class="button" href="' . esc_url(admin_url('admin.php?page=wplaunchguard-billing')) . '">Manage Billing</a></p>';
        }
        echo '</div>';

        echo '<div class="wplg-card">';
        echo '<h2>Latest Scan</h2>';
        if (is_wp_error($lastScan)) {
            echo '<p>' . esc_html($lastScan->get_error_message()) . '</p>';
        } elseif (!$lastScan) {
            echo '<p>No scans started yet.</p>';
        } else {
            $scan = $lastScan['data']['scan'] ?? [];
            $scanSummary = $this->extract_scan_summary($scan);
            $scanStatus = sanitize_key((string) ($scan['status'] ?? ''));
            echo '<p><strong>ID:</strong> ' . esc_html((string) ($scan['id'] ?? 'n/a')) . '</p>';
            echo '<p><strong>Status:</strong> ' . esc_html((string) ($scan['status'] ?? 'n/a')) . '</p>';
            echo '<p><strong>Created:</strong> ' . esc_html((string) ($scan['created_at'] ?? 'n/a')) . '</p>';
            echo '<p><strong>Completed:</strong> ' . esc_html((string) ($scan['completed_at'] ?? 'pending')) . '</p>';

            $progressPercent = $this->estimate_scan_progress($scanStatus, $scanSummary);
            echo '<p><strong>Progress:</strong> ' . esc_html((string) $progressPercent) . '%</p>';
            echo '<div class="wplg-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $progressPercent) . '">';
            echo '<span style="width:' . esc_attr((string) $progressPercent) . '%"></span>';
            echo '</div>';

            $etaText = $this->get_scan_eta_text($scanStatus);
            if ($etaText !== '') {
                echo '<p class="description">' . esc_html($etaText) . '</p>';
            }

            if ($this->is_scan_in_progress($scanStatus)) {
                $autoRefreshActive = true;
                echo '<p class="description">This page auto-refreshes every 15 seconds while your scan is running.</p>';
                echo '<p><a class="button" href="' . esc_url(admin_url('admin.php?page=wplaunchguard-dashboard')) . '">Refresh Now</a></p>';
            }

            $issuesTotal = $this->extract_issues_total($scanSummary);
            if ($issuesTotal !== null) {
                echo '<p><strong>Issues:</strong> ' . esc_html((string) $issuesTotal) . '</p>';
            }

            $severityText = $this->format_severity_counts($scanSummary);
            if ($severityText !== '') {
                echo '<p><strong>Severity:</strong> ' . esc_html($severityText) . '</p>';
            }

            if (!empty($scanSummary['run_state'])) {
                echo '<p><strong>Run State:</strong> ' . esc_html((string) $scanSummary['run_state']) . '</p>';
            }

            if (!empty($scanSummary['workflow_url'])) {
                echo '<p><a class="button" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['workflow_url']) . '">Open GitHub Run</a></p>';
            }

            if (!empty($scanSummary['report_index_url'])) {
                echo '<p><a class="button button-primary" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['report_index_url']) . '">View Report</a></p>';
            }

            if (!empty($scanSummary['reports_artifact_url'])) {
                echo '<p><a class="button" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['reports_artifact_url']) . '">Download Report ZIP</a></p>';
            }

            $evidenceText = $this->format_evidence_counts($scanSummary);
            if ($evidenceText !== '') {
                echo '<p><strong>Evidence:</strong> ' . esc_html($evidenceText) . '</p>';
            }
        }
        echo '</div>';
        echo '</div>';

        echo '<div class="wplg-card">';
        echo '<h2>Recent Scans</h2>';
        if (is_wp_error($scans)) {
            echo '<p>' . esc_html($scans->get_error_message()) . '</p>';
        } else {
            $rows = $scans['data']['scans'] ?? [];
            if (empty($rows)) {
                echo '<p>No scan history yet.</p>';
            } else {
                echo '<table class="widefat striped">';
                echo '<thead><tr><th>Scan ID</th><th>Status</th><th>Mode</th><th>Issues</th><th>Report</th><th>Created</th></tr></thead><tbody>';
                foreach ($rows as $row) {
                    $rowSummary = $this->extract_scan_summary($row);
                    $rowIssues = $this->extract_issues_total($rowSummary);
                    $reportUrl = (string) ($rowSummary['report_index_url'] ?? ($rowSummary['workflow_url'] ?? ($rowSummary['reports_artifact_url'] ?? '')));
                    echo '<tr>';
                    echo '<td>' . esc_html((string) ($row['id'] ?? '')) . '</td>';
                    echo '<td>' . esc_html((string) ($row['status'] ?? '')) . '</td>';
                    echo '<td>' . esc_html((string) ($row['form_mode'] ?? '')) . '</td>';
                    echo '<td>' . esc_html($rowIssues !== null ? (string) $rowIssues : 'n/a') . '</td>';
                    if ($reportUrl !== '') {
                        echo '<td><a target="_blank" rel="noopener" href="' . esc_url($reportUrl) . '">Open</a></td>';
                    } else {
                        echo '<td>n/a</td>';
                    }
                    echo '<td>' . esc_html((string) ($row['created_at'] ?? '')) . '</td>';
                    echo '</tr>';
                }
                echo '</tbody></table>';
            }
        }
        echo '</div>';

        if ($autoRefreshActive) {
            echo '<script>setTimeout(function(){ window.location.reload(); }, 15000);</script>';
        }

        echo '</div>';
    }

    public function render_branding(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);

        echo '<div class="wrap wplg-wrap">';
        echo '<h1>Branding</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in LaunchGuard Dashboard first.</p>';
            echo '</div>';
            return;
        }

        $brandingData = [
            'brand_name' => '',
            'logo_url' => '',
            'primary_color' => '#1f2937',
            'accent_color' => '#22c55e',
            'footer_text' => '',
            'hide_launchguard_branding' => 0
        ];

        $response = $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/branding');
        if (!is_wp_error($response) && isset($response['data']['branding']) && is_array($response['data']['branding'])) {
            $brandingData = array_merge($brandingData, $response['data']['branding']);
        }

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="wplg_save_branding" />';
        wp_nonce_field('wplg_save_branding');

        echo '<table class="form-table" role="presentation">';
        echo '<tr><th scope="row"><label for="wplg_brand_name">Brand Name</label></th><td><input class="regular-text" type="text" id="wplg_brand_name" name="brand_name" value="' . esc_attr((string) $brandingData['brand_name']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_logo_url">Logo URL</label></th><td><input class="regular-text" type="url" id="wplg_logo_url" name="logo_url" value="' . esc_attr((string) $brandingData['logo_url']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_primary_color">Primary Color</label></th><td><input type="color" id="wplg_primary_color" name="primary_color" value="' . esc_attr((string) $brandingData['primary_color']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_accent_color">Accent Color</label></th><td><input type="color" id="wplg_accent_color" name="accent_color" value="' . esc_attr((string) $brandingData['accent_color']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_footer_text">Footer Text</label></th><td><textarea class="large-text" rows="3" id="wplg_footer_text" name="footer_text">' . esc_textarea((string) $brandingData['footer_text']) . '</textarea></td></tr>';

        $checked = !empty($brandingData['hide_launchguard_branding']) ? 'checked' : '';
        echo '<tr><th scope="row">White-label Mode</th><td><label><input type="checkbox" name="hide_launchguard_branding" value="1" ' . esc_attr($checked) . ' /> Hide LaunchGuard branding in exported reports</label></td></tr>';
        echo '</table>';

        submit_button('Save Branding');
        echo '</form>';
        echo '</div>';
    }

    public function render_settings(): void
    {
        ?>
        <div class="wrap wplg-wrap">
            <h1>Settings</h1>
            <form method="post" action="options.php">
                <?php settings_fields('wplg_settings_group'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="wplg_api_base_url">API Base URL</label></th>
                        <td><input class="regular-text" type="url" id="wplg_api_base_url" name="wplg_api_base_url" value="<?php echo esc_attr($this->get_option(self::OPTION_API_BASE)); ?>" placeholder="https://launchguard-api.your-subdomain.workers.dev" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_site_token">Site Token</label></th>
                        <td><input class="regular-text" type="text" id="wplg_site_token" name="wplg_site_token" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_TOKEN)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_site_id">Site ID</label></th>
                        <td><input class="regular-text" type="text" id="wplg_site_id" name="wplg_site_id" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_tenant_id">Tenant ID</label></th>
                        <td><input class="regular-text" type="text" id="wplg_tenant_id" name="wplg_tenant_id" value="<?php echo esc_attr($this->get_option(self::OPTION_TENANT_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_default_form_mode">Default Form Mode</label></th>
                        <td>
                            <select id="wplg_default_form_mode" name="wplg_default_form_mode">
                                <?php $mode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run'); ?>
                                <option value="dry-run" <?php selected($mode, 'dry-run'); ?>>dry-run</option>
                                <option value="live" <?php selected($mode, 'live'); ?>>live</option>
                            </select>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>
        </div>
        <?php
    }

    public function render_billing(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);

        echo '<div class="wrap wplg-wrap">';
        echo '<h1>Billing</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in LaunchGuard Dashboard first.</p>';
            echo '</div>';
            return;
        }

        $response = $this->fetch_billing($siteId);
        if (is_wp_error($response)) {
            echo '<p>' . esc_html($response->get_error_message()) . '</p>';
            echo '</div>';
            return;
        }

        $data = is_array($response['data'] ?? null) ? $response['data'] : [];
        $billing = is_array($data['billing'] ?? null) ? $data['billing'] : [];
        $plans = is_array($data['plans'] ?? null) ? $data['plans'] : [];

        $currentPlanId = sanitize_text_field((string) ($billing['plan_id'] ?? 'starter'));
        $billingStatus = sanitize_text_field((string) ($billing['billing_status'] ?? 'trial'));
        $currentPeriodEnd = sanitize_text_field((string) ($billing['current_period_end'] ?? ''));

        echo '<div class="wplg-card">';
        echo '<h2>Current Subscription</h2>';
        echo '<p><strong>Plan:</strong> ' . esc_html($currentPlanId) . '</p>';
        echo '<p><strong>Status:</strong> ' . esc_html($billingStatus) . '</p>';
        if ($currentPeriodEnd !== '') {
            echo '<p><strong>Current Period End:</strong> ' . esc_html($currentPeriodEnd) . '</p>';
        }
        echo '</div>';

        if (empty($plans)) {
            echo '<div class="wplg-card"><p>No plans available yet.</p></div>';
            echo '</div>';
            return;
        }

        echo '<div class="wplg-plan-grid">';
        foreach ($plans as $plan) {
            $planId = sanitize_text_field((string) ($plan['id'] ?? ''));
            $planScans = (int) ($plan['scans_limit'] ?? 0);
            $planSites = (int) ($plan['sites_limit'] ?? 0);
            $planWhitelabel = !empty($plan['whitelabel']);
            $stripeConfigured = !empty($plan['stripe_price_configured']);
            $isCurrent = $planId === $currentPlanId;

            echo '<div class="wplg-card wplg-plan-card">';
            echo '<h2>' . esc_html(ucfirst($planId)) . '</h2>';
            if ($isCurrent) {
                echo '<p><span class="wplg-pill">Current</span></p>';
            }
            echo '<p><strong>Scans / month:</strong> ' . esc_html((string) $planScans) . '</p>';
            echo '<p><strong>Sites:</strong> ' . esc_html((string) $planSites) . '</p>';
            echo '<p><strong>White-label:</strong> ' . esc_html($planWhitelabel ? 'Included' : 'No') . '</p>';

            if (!$stripeConfigured) {
                echo '<p>Checkout not configured for this plan yet.</p>';
            }

            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="wplg_start_checkout" />';
            echo '<input type="hidden" name="plan_id" value="' . esc_attr($planId) . '" />';
            wp_nonce_field('wplg_start_checkout');

            $buttonText = $isCurrent ? 'Change Plan' : 'Choose Plan';
            $buttonDisabled = $stripeConfigured ? '' : ' disabled="disabled"';
            echo '<p><button class="button button-primary" type="submit"' . $buttonDisabled . '>' . esc_html($buttonText) . '</button></p>';
            echo '</form>';
            echo '</div>';
        }
        echo '</div>';

        echo '</div>';
    }

    public function handle_register_site(): void
    {
        $this->ensure_admin_post('wplg_register_site');

        $payload = [
            'site_url' => home_url('/'),
            'tenant_id' => 'tenant-' . substr(md5(home_url('/')), 0, 12),
            'tenant_name' => get_bloginfo('name'),
            'plan_id' => 'starter',
            'wp_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'plugin_version' => WPLG_VERSION,
            'timezone' => wp_timezone_string() ?: 'UTC'
        ];

        $response = $this->api_request('POST', '/v1/sites/register', $payload, false);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', $response->get_error_message());
        }

        $data = $response['data'];
        if (empty($data['site_id']) || empty($data['site_token'])) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Site registration response missing required fields.');
        }

        update_option(self::OPTION_SITE_ID, sanitize_text_field((string) $data['site_id']));
        update_option(self::OPTION_SITE_TOKEN, sanitize_text_field((string) $data['site_token']));
        update_option(self::OPTION_TENANT_ID, sanitize_text_field((string) ($data['tenant_id'] ?? '')));

        $this->redirect_with_notice('wplaunchguard-dashboard', 'success', 'Site registered successfully.');
    }

    public function handle_run_scan(): void
    {
        $this->ensure_admin_post('wplg_run_scan');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Connect the site before running scans.');
        }

        $formMode = $this->sanitize_form_mode(sanitize_text_field((string) ($_POST['form_mode'] ?? 'dry-run')));
        $sitemapUrl = esc_url_raw((string) ($_POST['sitemap_url'] ?? ''));

        update_option(self::OPTION_DEFAULT_FORM_MODE, $formMode);

        $payload = [
            'site_id' => $siteId,
            'profile' => 'full_qa_no_visual',
            'form_mode' => $formMode,
            'trigger' => 'manual'
        ];
        if ($sitemapUrl !== '') {
            $payload['sitemap_url'] = $sitemapUrl;
        }

        $response = $this->api_request('POST', '/v1/scans', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', $response->get_error_message());
        }

        $scanId = sanitize_text_field((string) ($response['data']['scan_id'] ?? ''));
        if ($scanId !== '') {
            update_option(self::OPTION_LAST_SCAN_ID, $scanId);
        }

        $this->redirect_with_notice('wplaunchguard-dashboard', 'success', 'Scan queued successfully.');
    }

    public function handle_save_branding(): void
    {
        $this->ensure_admin_post('wplg_save_branding');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-branding', 'error', 'Connect the site before saving branding.');
        }

        $payload = [
            'brand_name' => sanitize_text_field((string) ($_POST['brand_name'] ?? '')),
            'logo_url' => esc_url_raw((string) ($_POST['logo_url'] ?? '')),
            'primary_color' => sanitize_hex_color((string) ($_POST['primary_color'] ?? '')) ?: '#1f2937',
            'accent_color' => sanitize_hex_color((string) ($_POST['accent_color'] ?? '')) ?: '#22c55e',
            'footer_text' => sanitize_textarea_field((string) ($_POST['footer_text'] ?? '')),
            'hide_launchguard_branding' => !empty($_POST['hide_launchguard_branding'])
        ];

        $response = $this->api_request('PUT', '/v1/sites/' . rawurlencode($siteId) . '/branding', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-branding', 'error', $response->get_error_message());
        }

        $this->redirect_with_notice('wplaunchguard-branding', 'success', 'Branding saved.');
    }

    public function handle_start_checkout(): void
    {
        $this->ensure_admin_post('wplg_start_checkout');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Connect the site before starting checkout.');
        }

        $planId = sanitize_key((string) ($_POST['plan_id'] ?? ''));
        if (!in_array($planId, ['starter', 'growth', 'agency'], true)) {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Invalid plan selected.');
        }

        $successUrl = add_query_arg(
            [
                'page' => 'wplaunchguard-billing',
                'wplg_notice' => 'success',
                'wplg_message' => 'Checkout complete. Billing status may take up to 60 seconds to refresh.'
            ],
            admin_url('admin.php')
        );

        $cancelUrl = add_query_arg(
            [
                'page' => 'wplaunchguard-billing',
                'wplg_notice' => 'error',
                'wplg_message' => 'Checkout canceled.'
            ],
            admin_url('admin.php')
        );

        $payload = [
            'plan_id' => $planId,
            'success_url' => $successUrl,
            'cancel_url' => $cancelUrl
        ];

        $response = $this->api_request('POST', '/v1/sites/' . rawurlencode($siteId) . '/billing/checkout-session', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', $response->get_error_message());
        }

        $checkoutUrl = esc_url_raw((string) ($response['data']['checkout_url'] ?? ''));
        if ($checkoutUrl === '' || !preg_match('#^https://#', $checkoutUrl)) {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Checkout URL missing from API response.');
        }

        wp_redirect($checkoutUrl);
        exit;
    }

    private function ensure_admin_post(string $action): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }
        check_admin_referer($action);
    }

    private function get_api_base(): string
    {
        return untrailingslashit($this->get_option(self::OPTION_API_BASE));
    }

    private function get_option(string $key, string $default = ''): string
    {
        $value = get_option($key, $default);
        return is_string($value) ? $value : $default;
    }

    private function api_request(string $method, string $path, ?array $body = null, bool $includeSiteToken = true)
    {
        $base = $this->get_api_base();
        if ($base === '') {
            return new WP_Error('wplg_api_base_missing', 'Set API Base URL in LaunchGuard Settings first.');
        }

        $url = $base . '/' . ltrim($path, '/');
        $headers = ['Accept' => 'application/json'];

        if ($includeSiteToken) {
            $siteToken = $this->get_option(self::OPTION_SITE_TOKEN);
            if ($siteToken !== '') {
                $headers['x-launchguard-site-token'] = $siteToken;
            }
        }

        $args = [
            'method' => strtoupper($method),
            'timeout' => 25,
            'headers' => $headers
        ];

        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = wp_json_encode($body);
        }

        $response = wp_remote_request($url, $args);
        if (is_wp_error($response)) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);
        $rawBody = wp_remote_retrieve_body($response);
        $data = json_decode($rawBody, true);
        if (!is_array($data)) {
            $data = ['raw' => $rawBody];
        }

        if ($status >= 400) {
            $message = (string) ($data['error'] ?? ('API request failed with status ' . $status));
            return new WP_Error('wplg_api_error', $message);
        }

        return [
            'status' => $status,
            'data' => $data
        ];
    }

    private function fetch_limits(string $siteId)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/limits');
    }

    private function fetch_billing(string $siteId)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/billing');
    }

    private function fetch_scans(string $siteId, int $limit)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/scans?limit=' . max(1, min(50, $limit)));
    }

    private function fetch_last_scan()
    {
        $scanId = $this->get_option(self::OPTION_LAST_SCAN_ID);
        if ($scanId === '') {
            return null;
        }
        return $this->api_request('GET', '/v1/scans/' . rawurlencode($scanId));
    }

    private function extract_scan_summary(array $scanRow): array
    {
        if (isset($scanRow['summary']) && is_array($scanRow['summary'])) {
            return $scanRow['summary'];
        }

        if (!empty($scanRow['summary_json']) && is_string($scanRow['summary_json'])) {
            $decoded = json_decode($scanRow['summary_json'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return [];
    }

    private function is_scan_in_progress(string $status): bool
    {
        return in_array($status, ['queued', 'queued_local', 'running', 'dispatched'], true);
    }

    private function estimate_scan_progress(string $status, array $summary): int
    {
        if ($status === 'completed') {
            return 100;
        }

        if (in_array($status, ['failed', 'cancelled'], true)) {
            return 100;
        }

        $runState = sanitize_key((string) ($summary['run_state'] ?? ''));
        if ($runState === 'complete') {
            return 100;
        }

        if ($runState === 'partial') {
            return 90;
        }

        if ($status === 'dispatched') {
            return 70;
        }

        if ($status === 'running') {
            return 45;
        }

        if ($status === 'queued_local') {
            return 20;
        }

        if ($status === 'queued') {
            return 10;
        }

        return 0;
    }

    private function get_scan_eta_text(string $status): string
    {
        if ($status === 'queued' || $status === 'queued_local') {
            return 'Queued for processing. Expected start time is usually under 1 minute.';
        }

        if ($status === 'running' || $status === 'dispatched') {
            return 'Scan is running in the cloud. Typical quick-scan duration is about 2 to 6 minutes.';
        }

        if ($status === 'completed') {
            return 'Scan finished. Open the report artifact for full details.';
        }

        if ($status === 'failed') {
            return 'Scan failed. Check the latest run link and retry the scan.';
        }

        if ($status === 'cancelled') {
            return 'Scan was cancelled.';
        }

        return '';
    }

    private function extract_issues_total(array $summary): ?int
    {
        if (isset($summary['issues_total']) && is_numeric($summary['issues_total'])) {
            return (int) $summary['issues_total'];
        }

        if (isset($summary['run_counts']) && is_array($summary['run_counts']) && isset($summary['run_counts']['issueRows']) && is_numeric($summary['run_counts']['issueRows'])) {
            return (int) $summary['run_counts']['issueRows'];
        }

        return null;
    }

    private function format_severity_counts(array $summary): string
    {
        $counts = $summary['issue_severity_counts'] ?? ($summary['severity_counts'] ?? null);
        if (!is_array($counts) || empty($counts)) {
            return '';
        }

        $parts = [];
        foreach ($counts as $severity => $count) {
            if (!is_numeric($count)) {
                continue;
            }
            $parts[] = sprintf('%s: %d', (string) $severity, (int) $count);
        }

        return implode(', ', $parts);
    }

    private function format_evidence_counts(array $summary): string
    {
        $evidence = isset($summary['evidence']) && is_array($summary['evidence']) ? $summary['evidence'] : [];
        if (empty($evidence)) {
            return '';
        }

        $screenshots = isset($evidence['screenshots_count']) && is_numeric($evidence['screenshots_count']) ? (int) $evidence['screenshots_count'] : 0;
        $lighthouseHtml = isset($evidence['lighthouse_html_count']) && is_numeric($evidence['lighthouse_html_count']) ? (int) $evidence['lighthouse_html_count'] : 0;

        return sprintf('screenshots: %d, lighthouse reports: %d', $screenshots, $lighthouseHtml);
    }

    private function redirect_with_notice(string $page, string $status, string $message): void
    {
        $url = add_query_arg(
            [
                'page' => $page,
                'wplg_notice' => $status,
                'wplg_message' => $message
            ],
            admin_url('admin.php')
        );
        wp_safe_redirect($url);
        exit;
    }
}
