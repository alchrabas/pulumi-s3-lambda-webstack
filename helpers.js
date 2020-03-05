
/** Split a domain name into its subdomain and parent domain names.
 *e.g. "www.example.com" => "www", "example.com".
 */
function getDomainAndSubdomain(domain) {
    const parts = domain.split('.');
    if (parts.length < 2) {
        throw new Error(`No TLD found on ${domain}`);
    }
    if (parts.length === 2) {
        return { subdomain: '', parentDomain: domain };
    }

    const subdomain = parts[0];
    parts.shift();
    return {
        subdomain,
        // Trailing "." to canonicalize domain.
        parentDomain: parts.join('.') + '.',
    };
}

module.exports = {
    getDomainAndSubdomain,
};