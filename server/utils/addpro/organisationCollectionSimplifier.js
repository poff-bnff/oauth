export async function simplifyOrganisationCollection(organisation, user = null, extended = true) {

    const simplifiedObject = {
        id: organisation.id,
        name_en: organisation.name_en,
        name_et: organisation.name_et,
        name_ru: organisation.name_ru,
        slug_en: organisation.slug_en,
        orderedRaF: formatOrderedRaF(organisation.orderedRaF),
        employees_n: organisation.employees_n,
        people: organisation.people.map(people => people.id),
        h_rate_from: organisation.h_rate_from,
        h_rate_to: organisation.h_rate_to,
        languages: organisation.languages.map(language => language.id),
        profile_img: formatMedia(organisation.profile_img),
        logoColour: formatMedia(organisation.logoColour),
        skills_en: organisation.skills_en,
        description_en: organisation.description_en,
        tag_looking_fors: organisation.tag_looking_fors.map(looking_for => looking_for.id),

        webpage_url: organisation.webpage_url,
        acc_imdb: organisation.acc_imdb,
        acc_efis: organisation.acc_efis,
        acc_instagram: organisation.acc_instagram,
        acc_fb: organisation.acc_fb,
        acc_other: organisation.acc_other,
        acc_youtube: organisation.acc_youtube,
        acc_vimeo: organisation.acc_vimeo,

        phoneNr: organisation.phoneNr,
        eMail: organisation.eMail,

        addr_coll: formatAddressFields(organisation.addr_coll),


        showreel: organisation.showreel,
        audioreel: formatMedia(organisation.audioreel),
        images: formatImages(organisation.images),
    }

    if (user !== null) {
        simplifiedObject['ok_to_contact'] = user.ok_to_contact
    }

    if (extended) {
        simplifiedObject['filmographies'] = await formatFilmographies(organisation.filmographies);
        simplifiedObject['clients'] = await formatClients(organisation.clients);
    }
    return simplifiedObject
}

function formatAddressFields(addr_coll)
{
    if (!addr_coll) {
        return addr_coll
    }
    return {
        id: addr_coll.id,
        country: addr_coll.country,
        county: addr_coll.county,
        municipality: addr_coll.municipality,
        add_county: addr_coll.add_county,
        add_municipality: addr_coll.add_municipality,
        popul_place: addr_coll.popul_place,
        street_name: addr_coll.street_name,
        appartment: addr_coll.appartment,
        postal_code: addr_coll.postal_code,
        address_number: addr_coll.address_number,
    }
}

function formatMedia(image) {
    if (!image) {
        return image
    }
    return {
        id: image.id,
        caption: image.caption,
        hash: image.hash,
        ext: image.ext,
    }
}
function formatImages(images) {
    return images.map(image => formatMedia(image))
}

function formatOrderedRaF(orderedRaF) {
    return orderedRaF.filter(ordered_role_at_film => ordered_role_at_film.role_at_film).map(ordered_role_at_film => {
        return {
            id: ordered_role_at_film.id,
            order: ordered_role_at_film.order,
            role_at_film: {id: ordered_role_at_film.role_at_film.id}
        }
    });
}

async function formatClients(originalClients) {
    if (!originalClients.length) {
        return originalClients
    }
    const clientIds = originalClients.map(function (client) {
        return client.id;
    });

    const clients = await getStrapiClients(clientIds)
    return clients.map(client => {
        return {
            id: client.id,
            name: client.client_organisation.name_en,
            description: client.description,
            url: client.url
        }
    });
}

async function formatFilmographies(originalFilmographies) {

    if (!originalFilmographies.length) {
        return [];
    }
    const filmographiesIds = originalFilmographies.map(function (element) {
        return element.id;
    });

    const filmographies = await getStrapiFilmographies(filmographiesIds)
    return filmographies.map(filmography => {
        return {
            id: filmography.id,
            work_name: filmography.work_name,
            work_url: filmography.work_url,
            decsription_en: filmography.decsription_en,
            org_name: filmography.org_name,
            org_department: filmography.org_department,
            degree: filmography.degree,
            org_url: filmography.org_url,
            runtime: filmography.runtime,
            year_from: filmography.year_from,
            year_to: filmography.year_to,
            url: filmography.url,
            is_featured: filmography.is_featured,
            type_of_work: filmography.type_of_work?.id,
            is_ongoing: filmography.is_ongoing,
            role_at_films: filmography.role_at_films.map(role_at_film => role_at_film.id),
            project_statuses: filmography.project_statuses.map(project_status => project_status.id),
            tag_looking_fors: filmography.tag_looking_fors.map(tag_looking_for => tag_looking_for.id),
            stills: filmography.stills.map(still => {
                return {
                    id: still.id,
                    hash: still.hash,
                    ext: still.ext
                }
            })
        }
    })
}
